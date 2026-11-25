import { codexContextSnapshot, codexContextSnapshotAfter, codexRolloutMarker } from './context.js';

/**
 * Native in-place compaction for Codex via `codex app-server` JSON-RPC
 * (`thread/compact/start`). Keeps the same thread and model without sending
 * the full transcript through a separate summarization turn.
 */

function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function rpcErrorMessage(error) {
    const rec = asRecord(error);
    if (!rec) return String(error);
    const msg = typeof rec.message === 'string' && rec.message.trim() ? rec.message.trim() : 'request failed';
    return typeof rec.code === 'number' ? `${msg} (code ${rec.code})` : msg;
}

function notificationThreadId(params) {
    if (!params) return null;
    if (typeof params.threadId === 'string') return params.threadId;
    if (typeof params.thread_id === 'string') return params.thread_id;
    return null;
}

function extractNotificationTokens(params) {
    const usage = asRecord(params?.tokenUsage) ?? asRecord(params?.token_usage) ?? asRecord(params?.info);
    if (!usage) return undefined;
    const last = asRecord(usage.last) ?? asRecord(usage.last_token_usage) ?? asRecord(usage.lastTokenUsage);
    return positiveNumber(last?.inputTokens)
        ?? positiveNumber(last?.input_tokens)
        ?? positiveNumber(last?.totalTokens)
        ?? positiveNumber(last?.total_tokens);
}

function abortError(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    if (typeof reason === 'string' && reason.trim()) return new Error(reason.trim());
    return new Error('codex compaction aborted');
}

/**
 * Compacts an existing Codex thread in place using `codex app-server`.
 * Runs `initialize` → `initialized` → `thread/resume` → `thread/compact/start`
 * and waits for the compaction turn's `turn/completed` notification.
 */
export async function compactCodexThread(binary, ctx, binaryName = 'codex') {
    const sessionId = typeof ctx?.sessionId === 'string' ? ctx.sessionId.trim() : '';
    if (!sessionId) {
        throw new Error('codex native compaction requires a session id');
    }
    if (!ctx?.scratch) {
        throw new Error('codex native compaction requires a mission scratch directory');
    }
    if (ctx.signal?.aborted) {
        throw abortError(ctx.signal);
    }

    const preRollout = codexRolloutMarker(ctx.scratch);
    let preTokens = positiveNumber(codexContextSnapshot(ctx.scratch)?.tokens);
    let notifiedPostTokens;
    const env = { ...(ctx.env ?? {}), CODEX_HOME: ctx.scratch };
    const conversation = await binary.converse(binaryName, ['app-server'], {
        env,
        timeoutMs: ctx.timeoutMs,
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        let compactStarted = false;
        let sawCompactionItem = false;
        let unsubscribe = () => {};

        const onAbort = () => {
            finish(abortError(ctx.signal));
        };

        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
            unsubscribe();
            void conversation.stop();
            if (err) reject(err);
            else resolve(result);
        };

        if (ctx.signal) {
            if (ctx.signal.aborted) {
                return finish(abortError(ctx.signal));
            }
            ctx.signal.addEventListener('abort', onAbort, { once: true });
        }

        const send = (payload) => {
            conversation.write(`${JSON.stringify(payload)}\n`);
        };

        void conversation.exited.then(({ code, signal }) => {
            finish(new Error(`codex app-server exited before compaction completed (${code ?? signal ?? 'unknown'})`));
        });

        unsubscribe = conversation.onData((chunk) => {
            buffer += Buffer.from(chunk).toString('utf8');
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;

                let msg;
                try {
                    msg = asRecord(JSON.parse(line));
                } catch {
                    continue;
                }
                if (!msg) continue;

                if (msg.id === 1) {
                    if (msg.error) {
                        return finish(new Error(`codex app-server initialize failed: ${rpcErrorMessage(msg.error)}`));
                    }
                    send({ method: 'initialized', params: {} });
                    const resumeParams = {
                        threadId: sessionId,
                        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
                        ...(ctx.model ? { model: ctx.model } : {}),
                    };
                    send({ id: 2, method: 'thread/resume', params: resumeParams });
                    continue;
                }

                if (msg.id === 2) {
                    if (msg.error) {
                        return finish(new Error(`codex app-server thread/resume failed: ${rpcErrorMessage(msg.error)}`));
                    }
                    send({ id: 3, method: 'thread/compact/start', params: { threadId: sessionId } });
                    continue;
                }

                if (msg.id === 3) {
                    if (msg.error) {
                        return finish(new Error(`codex app-server thread/compact/start failed: ${rpcErrorMessage(msg.error)}`));
                    }
                    compactStarted = true;
                    continue;
                }

                if (typeof msg.method !== 'string') continue;
                const params = asRecord(msg.params);
                const threadId = notificationThreadId(params);
                if (threadId && threadId !== sessionId) continue;

                if (msg.method === 'thread/tokenUsage/updated') {
                    const tokens = extractNotificationTokens(params);
                    if (tokens !== undefined) {
                        if (compactStarted) notifiedPostTokens = tokens;
                        else if (preTokens === undefined) preTokens = tokens;
                    }
                    continue;
                }

                if (msg.method === 'item/completed') {
                    const item = asRecord(params?.item);
                    const type = typeof item?.type === 'string' ? item.type : '';
                    if (type === 'contextCompaction' || type === 'context_compaction') {
                        sawCompactionItem = true;
                    }
                    continue;
                }

                if (msg.method === 'turn/completed' && compactStarted) {
                    const turn = asRecord(params?.turn);
                    const status = typeof turn?.status === 'string' ? turn.status : 'completed';
                    if (status === 'failed' || status === 'interrupted') {
                        const errRec = asRecord(turn?.error);
                        const detail = typeof errRec?.message === 'string' && errRec.message.trim()
                            ? `: ${errRec.message.trim()}`
                            : '';
                        return finish(new Error(`codex compaction ${status}${detail}`));
                    }
                    const postTokens = notifiedPostTokens
                        ?? positiveNumber(codexContextSnapshotAfter(ctx.scratch, preRollout)?.tokens);
                    return finish(null, {
                        metadata: {
                            method: 'thread/compact/start',
                            ...(sawCompactionItem ? { context_compaction: true } : {}),
                            ...(preTokens !== undefined ? { pre_tokens: preTokens } : {}),
                            ...(postTokens !== undefined ? { post_tokens: postTokens } : {}),
                        },
                    });
                }

                if (msg.method === 'error' && compactStarted && params?.willRetry === false) {
                    const errRec = asRecord(params.error);
                    const detail = typeof errRec?.message === 'string' && errRec.message.trim()
                        ? errRec.message.trim()
                        : typeof params.message === 'string' && params.message.trim()
                            ? params.message.trim()
                            : 'unknown error';
                    return finish(new Error(`codex compaction error: ${detail}`));
                }
            }
        });

        send({
            id: 1,
            method: 'initialize',
            params: { clientInfo: { name: 'timon', version: '0' } },
        });
    });
}
