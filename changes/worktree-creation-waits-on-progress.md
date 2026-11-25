---
type: fixed
tim: TIM-0164
---
A Kanban task on a large repository is no longer blocked after 30 seconds while git is still checking out its worktree: Timon waits as long as git reports progress, and a checkout that stalls is stopped and cleaned up instead of being left half-made.
