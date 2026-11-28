/**
 * The MSAA (IAccessible) fallback of the Windows accessibility backend, as PowerShell added to the
 * persistent worker. Fixed text: requests are JSON read as data, never spliced into a script.
 *
 * Why it exists: the managed UI Automation client (System.Windows.Automation, UIA2) cannot see the web
 * content of Chromium and Electron; it stops at a "Chrome Legacy Window" group (the child window of
 * class Chrome_RenderWidgetHostHWND) with no children. The same content is reachable through oleacc
 * (AccessibleObjectFromWindow, AccessibleChildren), which ships with Windows and needs no dependency.
 *
 * Ids: the path continues the UIA path. Under the Legacy Window element, `.0` is the MSAA root and
 * each next index is the position among its MSAA children. The walk is done in C# so a 400-element
 * page costs a few hundred in-process calls, not a PowerShell round trip per property.
 */
export const WINDOWS_MSAA_LIB = String.raw`
$script:msaaReady = $false
function Initialize-TimonMsaa {
  if ($script:msaaReady) { return }
  Add-Type -AssemblyName Accessibility
  $ref = [Accessibility.IAccessible].Assembly.Location
  Add-Type -ReferencedAssemblies $ref -Language CSharp -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;
public class TimonMsaaNode { public IAccessible Acc; public int Id; }
public class TimonMsaaResult { public bool Truncated; public List<object[]> Rows = new List<object[]>(); }
public static class TimonMsaa {
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object obj);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible c, int start, int count, [Out] object[] kids, out int got);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  public static long FindChild(long parent, string cls) {
    long found = 0;
    EnumChildWindows(new IntPtr(parent), delegate (IntPtr h, IntPtr l) {
      StringBuilder s = new StringBuilder(256); GetClassName(h, s, s.Capacity);
      if (s.ToString() == cls) { found = h.ToInt64(); return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static TimonMsaaNode Root(long hwnd) {
    Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); object o;
    int hr = AccessibleObjectFromWindow(new IntPtr(hwnd), 0xFFFFFFFC, ref iid, out o);
    IAccessible acc = o as IAccessible;
    if (hr != 0 || acc == null) return null;
    TimonMsaaNode n = new TimonMsaaNode(); n.Acc = acc; n.Id = 0; return n;
  }
  public static int ChildCount(TimonMsaaNode n) { try { return n.Acc.accChildCount; } catch { return 0; } }
  static TimonMsaaNode[] Kids(TimonMsaaNode n, int cap) {
    if (n.Id != 0) return new TimonMsaaNode[0];
    int count = ChildCount(n); if (count > cap) count = cap; if (count <= 0) return new TimonMsaaNode[0];
    object[] arr = new object[count]; int got = 0;
    try { if (AccessibleChildren(n.Acc, 0, count, arr, out got) < 0) return new TimonMsaaNode[0]; } catch { return new TimonMsaaNode[0]; }
    TimonMsaaNode[] kids = new TimonMsaaNode[got];
    for (int i = 0; i < got; i++) {
      if (arr[i] is int) { TimonMsaaNode k = new TimonMsaaNode(); k.Acc = n.Acc; k.Id = (int)arr[i]; kids[i] = k; }
      else { IAccessible a = arr[i] as IAccessible; if (a != null) { TimonMsaaNode k = new TimonMsaaNode(); k.Acc = a; k.Id = 0; kids[i] = k; } }
    }
    return kids;
  }
  static string Str(object o) { return o == null ? "" : o.ToString(); }
  // role, name, value, state, x, y, width, height, default action. A property that throws is empty.
  public static object[] Describe(TimonMsaaNode n) {
    object id = n.Id; int role = 0, state = 0, x = 0, y = 0, w = 0, h = 0; string name = "", value = "", def = "";
    try { object r = n.Acc.get_accRole(id); if (r is int) role = (int)r; } catch { }
    try { state = Convert.ToInt32(n.Acc.get_accState(id)); } catch { }
    try { name = Str(n.Acc.get_accName(id)); } catch { }
    // 0x20000000 is PROTECTED, a password field: its value is never read.
    bool protectedField = (state & 0x20000000) != 0;
    if (!protectedField && (role == 0x2A || role == 0x2E || role == 0x33)) { try { value = Str(n.Acc.get_accValue(id)); } catch { } }
    try { n.Acc.accLocation(out x, out y, out w, out h, id); } catch { }
    try { def = Str(n.Acc.get_accDefaultAction(id)); } catch { }
    return new object[] { role, name, value, state, x, y, w, h, def };
  }
  static void Walk(TimonMsaaNode n, string path, int depth, int maxDepth, int maxNodes, TimonMsaaResult r) {
    if (r.Rows.Count >= maxNodes || depth >= maxDepth) { r.Truncated = true; return; }
    object[] d = Describe(n);
    // 0x8000 is INVISIBLE: a hidden element and what is under it are not on the page.
    if (((int)d[3] & 0x8000) != 0) return;
    r.Rows.Add(new object[] { path, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8] });
    TimonMsaaNode[] kids = Kids(n, maxNodes);
    for (int i = 0; i < kids.Length; i++) {
      if (kids[i] == null) continue;
      if (r.Rows.Count >= maxNodes) { r.Truncated = true; return; }
      Walk(kids[i], path + "." + i, depth + 1, maxDepth, maxNodes, r);
    }
  }
  public static TimonMsaaResult WalkFrom(TimonMsaaNode root, string path, int maxDepth, int maxNodes) {
    TimonMsaaResult r = new TimonMsaaResult(); Walk(root, path, 0, maxDepth, maxNodes, r); return r;
  }
  public static TimonMsaaNode Resolve(TimonMsaaNode root, int[] indices) {
    TimonMsaaNode n = root;
    foreach (int i in indices) {
      TimonMsaaNode[] kids = Kids(n, i + 1);
      if (i >= kids.Length || kids[i] == null) return null;
      n = kids[i];
    }
    return n;
  }
  public static void DoDefault(TimonMsaaNode n) { n.Acc.accDoDefaultAction((object)n.Id); }
  public static void SetValue(TimonMsaaNode n, string v) { n.Acc.set_accValue((object)n.Id, v); }
  public static void Select(TimonMsaaNode n, int flags) { n.Acc.accSelect(flags, (object)n.Id); }
}
"@
  $script:msaaReady = $true
}
function Get-TimonMsaaRole($role) {
  switch ([int]$role) {
    1 { 'window' } 2 { 'menubar' } 3 { 'scrollbar' } 9 { 'window' } 10 { 'group' } 11 { 'menu' } 12 { 'menuitem' }
    15 { 'group' } 16 { 'group' } 20 { 'group' } 22 { 'toolbar' } 24 { 'table' } 28 { 'row' } 29 { 'cell' }
    30 { 'link' } 33 { 'list' } 34 { 'listitem' } 35 { 'list' } 36 { 'listitem' } 37 { 'tab' } 60 { 'tablist' }
    40 { 'image' } 41 { 'text' } 42 { 'textfield' } 43 { 'button' } 62 { 'button' } 44 { 'checkbox' } 45 { 'radio' }
    46 { 'combobox' } 51 { 'slider' }
    default { 'other' }
  }
}
function Get-TimonMsaaActions($role, $state, [string]$def) {
  $actions = New-Object System.Collections.ArrayList
  if ($def -ne '') { [void]$actions.Add('press') }
  if (($state -band 0x100000) -ne 0) { [void]$actions.Add('focus') }
  # 0x1 is UNAVAILABLE, 0x40 READONLY, 0x20000000 PROTECTED (still writable, never readable).
  if ([int]$role -eq 0x2A -and ($state -band 0x41) -eq 0) { [void]$actions.Add('set_value') }
  if (($state -band 0x200000) -ne 0) { [void]$actions.Add('select') }
  ,@($actions)
}
function Get-TimonMsaaHwnd($el) {
  $A = [System.Windows.Automation.AutomationElement]
  $class = [string](Get-TimonUiaCached $el $A::ClassNameProperty)
  $h = [long](Get-TimonUiaCached $el $A::NativeWindowHandleProperty)
  if ($h -eq 0) { return [long]0 }
  if ($class -eq 'Chrome_RenderWidgetHostHWND') { return $h }
  if ($class -like 'Chrome_WidgetWin_*') { Initialize-TimonMsaa; return [TimonMsaa]::FindChild($h, 'Chrome_RenderWidgetHostHWND') }
  return [long]0
}
# The MSAA root of a Chromium web area, read again for up to about 0.5 s while it is still empty.
function Get-TimonMsaaRoot($el) {
  $hwnd = Get-TimonMsaaHwnd $el
  if ($hwnd -eq 0) { return $null }
  Initialize-TimonMsaa
  for ($try = 0; $try -lt 4; $try++) {
    $root = [TimonMsaa]::Root($hwnd)
    if ($null -ne $root -and [TimonMsaa]::ChildCount($root) -gt 0) { return $root }
    Start-Sleep -Milliseconds 150
  }
  return $null
}
# Adds the MSAA nodes under a Chromium web area; true when MSAA answered, so the caller skips UIA.
function Add-TimonMsaaNodes($el, [string]$path, [int]$depth, $state) {
  $root = Get-TimonMsaaRoot $el
  $debug = ($env:TIMON_COMPUTER_USE_DEBUG -eq '1')
  if ($null -eq $root) {
    if ($debug -and (Get-TimonMsaaHwnd $el) -ne 0) { [Console]::Error.WriteLine('[computer-use] a11y: MSAA found no children under the web area at ' + $path) }
    return $false
  }
  $res = [TimonMsaa]::WalkFrom($root, ($path + '.0'), [Math]::Max(0, $state.maxDepth - $depth - 1), [Math]::Max(0, $state.maxNodes - $state.nodes.Count))
  $s = $script:uiaScale
  foreach ($row in $res.Rows) {
    $node = @{ path = [string]$row[0]; role = (Get-TimonMsaaRole $row[1]); name = [string]$row[2]; enabled = (([int]$row[4] -band 0x1) -eq 0); actions = (Get-TimonMsaaActions $row[1] ([int]$row[4]) ([string]$row[9])) }
    if ([string]$row[3] -ne '') { $node.value = [string]$row[3] }
    if (([int]$row[4] -band 0x4) -ne 0) { $node.focused = $true }
    if ([int]$row[7] -gt 0 -and [int]$row[8] -gt 0) { $node.bounds = @{ x = [math]::Round([int]$row[5] / $s); y = [math]::Round([int]$row[6] / $s); width = [math]::Round([int]$row[7] / $s); height = [math]::Round([int]$row[8] / $s) } }
    [void]$state.nodes.Add($node)
  }
  if ($res.Truncated) { $state.truncated = $true }
  if ($debug) { [Console]::Error.WriteLine('[computer-use] a11y: path MSAA at ' + $path + ', ' + $res.Rows.Count + ' children found') }
  return $true
}
function Invoke-TimonMsaaAct($q, $root, $steps) {
  $node = [TimonMsaa]::Resolve($root, [int[]]@($steps))
  if ($null -eq $node) { return @{ stale = $true } }
  $d = [TimonMsaa]::Describe($node)
  $possible = Get-TimonMsaaActions $d[0] ([int]$d[3]) ([string]$d[8])
  $unsupported = @{ unsupported = $true; actions = @($possible) }
  try {
    switch ($q.action) {
      'press' { if ($possible -notcontains 'press') { return $unsupported }; [TimonMsaa]::DoDefault($node) }
      'focus' { if ($possible -notcontains 'focus') { return $unsupported }; [TimonMsaa]::Select($node, 1) }
      'select' { if ($possible -notcontains 'select') { return $unsupported }; [TimonMsaa]::Select($node, 2) }
      'set_value' {
        if ($possible -notcontains 'set_value') { return $unsupported }
        $want = [string]$q.value
        $done = $false
        try {
          [TimonMsaa]::SetValue($node, $want)
          # Chromium can accept the call and change nothing: read it back (never for a password).
          # Chromium applies the value a moment later: read it back for up to about 0.6 s before calling
          # it refused (an immediate read reported a refusal for a field that had changed, CI 46015708886).
          if (([int]$d[3] -band 0x20000000) -ne 0) { $done = $true } else {
            for ($try = 0; $try -lt 7 -and -not $done; $try++) {
              if ($try -gt 0) { Start-Sleep -Milliseconds 100 }
              $done = ([string][TimonMsaa]::Describe($node)[2] -eq $want)
            }
          }
        } catch { $done = $false }
        if (-not $done) {
          # Background mode: no keyboard, no focus. The agent is told to do without.
          if ($q.background -eq $true) { return @{ failed = $true } }
          # Last resort: focus the field, select all and type. It uses the keyboard, so the window must
          # already be the foreground one, which is the app the allow list was checked against.
          [TimonMsaa]::Select($node, 1)
          if ([TimonInput]::Foreground() -ne [long]$q.id) { return @{ failed = $true } }
          $keys = New-Object System.Collections.ArrayList
          [void]$keys.Add(@{ t = 'key'; vk = 0x11; up = $false }); [void]$keys.Add(@{ t = 'key'; vk = 0x41; up = $false })
          [void]$keys.Add(@{ t = 'key'; vk = 0x41; up = $true }); [void]$keys.Add(@{ t = 'key'; vk = 0x11; up = $true })
          if ($want -eq '') { [void]$keys.Add(@{ t = 'key'; vk = 0x2E; up = $false }); [void]$keys.Add(@{ t = 'key'; vk = 0x2E; up = $true }) }
          foreach ($c in $want.ToCharArray()) { [void]$keys.Add(@{ t = 'unicode'; unit = [int]$c; up = $false }); [void]$keys.Add(@{ t = 'unicode'; unit = [int]$c; up = $true }) }
          Invoke-TimonSteps @($keys)
        }
      }
      default { return $unsupported }
    }
  } catch { return @{ failed = $true } }
  return @{ ok = $true }
}
`;
