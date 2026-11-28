# Diagnostic of the Windows accessibility backend, run by computer-use-e2e.mjs only when a field or a
# button comes back without its action. It prints what UI Automation and MSAA really expose for one
# window, so a failure on a CI runner can be understood from the log alone. Not part of the product.
#
# Stages: tree (UIA walk with live and cached reads, then the MSAA trees), uia-act (ValuePattern and
# InvokePattern on the "Nom" field and the "Valider" button), msaa-act (set_accValue and
# accDoDefaultAction on the same elements). The caller reads the page between stages.
param([Parameter(Mandatory = $true)][long]$Hwnd, [string]$Stage = 'tree')
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, Accessibility
$ref = [Accessibility.IAccessible].Assembly.Location
Add-Type -ReferencedAssemblies $ref -Language CSharp -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;
public static class DiagMsaa {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object obj);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible c, int start, int count, [Out] object[] kids, out int got);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  public static List<string> ChildWindows(long parent) {
    List<string> list = new List<string>();
    EnumChildWindows(new IntPtr(parent), delegate (IntPtr h, IntPtr l) {
      StringBuilder s = new StringBuilder(256); GetClassName(h, s, s.Capacity);
      list.Add(h.ToInt64() + " class=" + s + " visible=" + IsWindowVisible(h) + " parent=" + GetParent(h).ToInt64());
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static long[] ChildHandles(long parent) {
    List<long> list = new List<long>();
    EnumChildWindows(new IntPtr(parent), delegate (IntPtr h, IntPtr l) { list.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static IAccessible Root(long hwnd, uint objid, out int hr) {
    Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); object o = null;
    hr = AccessibleObjectFromWindow(new IntPtr(hwnd), objid, ref iid, out o);
    return o as IAccessible;
  }
  class Item { public IAccessible Acc; public int Id; }
  static List<Item> Kids(Item n, List<string> errors) {
    List<Item> kids = new List<Item>();
    if (n.Id != 0) return kids;
    int count = 0;
    try { count = n.Acc.accChildCount; } catch (Exception e) { errors.Add("accChildCount: " + e.GetType().Name); return kids; }
    if (count <= 0) return kids; if (count > 200) count = 200;
    object[] arr = new object[count]; int got = 0;
    int hr = AccessibleChildren(n.Acc, 0, count, arr, out got);
    if (hr < 0) { errors.Add("AccessibleChildren hr=0x" + hr.ToString("x8")); return kids; }
    for (int i = 0; i < got; i++) {
      if (arr[i] is int) { Item k = new Item(); k.Acc = n.Acc; k.Id = (int)arr[i]; kids.Add(k); }
      else { IAccessible a = arr[i] as IAccessible; if (a != null) { Item k = new Item(); k.Acc = a; k.Id = 0; kids.Add(k); } else { errors.Add("child " + i + " is " + (arr[i] == null ? "null" : arr[i].GetType().Name)); } }
    }
    return kids;
  }
  static string Describe(Item n) {
    object id = n.Id; StringBuilder s = new StringBuilder();
    try { object r = n.Acc.get_accRole(id); s.Append("role=" + (r is int ? "0x" + ((int)r).ToString("x") : Convert.ToString(r))); } catch (Exception e) { s.Append("role=ERR " + e.GetType().Name); }
    try { s.Append(" name='" + n.Acc.get_accName(id) + "'"); } catch (Exception e) { s.Append(" name=ERR " + e.GetType().Name); }
    try { s.Append(" state=0x" + Convert.ToInt32(n.Acc.get_accState(id)).ToString("x")); } catch (Exception e) { s.Append(" state=ERR " + e.GetType().Name); }
    try { s.Append(" def='" + n.Acc.get_accDefaultAction(id) + "'"); } catch (Exception e) { s.Append(" def=ERR " + e.GetType().Name); }
    try { s.Append(" value='" + n.Acc.get_accValue(id) + "'"); } catch (Exception e) { s.Append(" value=ERR " + e.GetType().Name); }
    try { int x, y, w, h; n.Acc.accLocation(out x, out y, out w, out h, id); s.Append(" loc=" + x + "," + y + " " + w + "x" + h); } catch (Exception e) { s.Append(" loc=ERR " + e.GetType().Name); }
    if (n.Id == 0) { try { s.Append(" kids=" + n.Acc.accChildCount); } catch { s.Append(" kids=ERR"); } } else { s.Append(" simple-child=" + n.Id); }
    return s.ToString();
  }
  public static List<string> Walk(IAccessible acc, int maxDepth, int maxNodes) {
    List<string> lines = new List<string>(); List<string> errors = new List<string>();
    Item root = new Item(); root.Acc = acc; root.Id = 0;
    WalkFrom(root, 0, maxDepth, maxNodes, lines, errors);
    foreach (string e in errors) lines.Add("  (error) " + e);
    return lines;
  }
  static void WalkFrom(Item n, int depth, int maxDepth, int maxNodes, List<string> lines, List<string> errors) {
    if (lines.Count >= maxNodes) return;
    lines.Add(new string(' ', depth * 2) + Describe(n));
    if (depth >= maxDepth) return;
    foreach (Item k in Kids(n, errors)) WalkFrom(k, depth + 1, maxDepth, maxNodes, lines, errors);
  }
  static Item Find(Item n, string name, int role, int depth, List<string> errors) {
    if (depth > 20) return null;
    try {
      object r = n.Acc.get_accRole((object)n.Id);
      if (r is int && (int)r == role && Convert.ToString(n.Acc.get_accName((object)n.Id)) == name) return n;
    } catch { }
    foreach (Item k in Kids(n, errors)) { Item f = Find(k, name, role, depth + 1, errors); if (f != null) return f; }
    return null;
  }
  public static string Act(IAccessible acc, string name, int role, string value) {
    List<string> errors = new List<string>(); Item root = new Item(); root.Acc = acc; root.Id = 0;
    Item n = Find(root, name, role, 0, errors);
    if (n == null) return "not found (" + string.Join("; ", errors.ToArray()) + ")";
    try {
      if (value != null) { n.Acc.set_accValue((object)n.Id, value); return "set_accValue returned; now " + Describe(n); }
      n.Acc.accDoDefaultAction((object)n.Id); return "accDoDefaultAction returned; now " + Describe(n);
    } catch (Exception e) { return "threw " + e.GetType().Name + ": " + e.Message; }
  }
}
"@

function Out-Diag([string]$line) { [Console]::Out.WriteLine('diag: ' + $line) }
[void][DiagMsaa]::SetProcessDPIAware()
$A = [System.Windows.Automation.AutomationElement]
$VP = [System.Windows.Automation.ValuePattern]
$IP = [System.Windows.Automation.InvokePattern]
$providerDescription = $null
try { $providerDescription = [System.Windows.Automation.AutomationProperty]::LookupById(30107) } catch { }
$cr = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::ClassNameProperty, $A::BoundingRectangleProperty, $A::IsKeyboardFocusableProperty,
    $A::IsValuePatternAvailableProperty, $A::IsInvokePatternAvailableProperty, $VP::IsReadOnlyProperty)) { $cr.Add($p) }
$cr.TreeScope = [System.Windows.Automation.TreeScope]::Element
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Get-Live($el, $p) {
  try { $v = $el.GetCurrentPropertyValue($p, $true); if ([object]::ReferenceEquals($v, $A::NotSupported)) { 'NotSupported' } else { [string]$v } } catch { 'ERR ' + $_.Exception.GetType().Name }
}
function Get-Cached($el, $p) {
  try { $c = $el.GetUpdatedCache($cr) } catch { return 'ERR cache ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
  try { $v = $c.GetCachedPropertyValue($p, $true); if ([object]::ReferenceEquals($v, $A::NotSupported)) { 'NotSupported' } else { [string]$v } } catch { 'ERR ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
}
function Get-Patterns($el) {
  try { ($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers.Pattern', '' }) -join ',' } catch { 'ERR ' + $_.Exception.GetType().Name }
}
function Show-UiaNode($el, [int]$depth, $counter) {
  if ($counter.n -ge 60 -or $depth -gt 14) { return }
  $counter.n++
  $type = Get-Live $el $A::ControlTypeProperty
  try { $type = $el.Current.ControlType.ProgrammaticName } catch { }
  $line = ('  ' * $depth) + $type + " name='" + (Get-Live $el $A::NameProperty) + "' class='" + (Get-Live $el $A::ClassNameProperty) + "' fw='" + (Get-Live $el $A::FrameworkIdProperty) + "'"
  $line += ' hwnd=' + (Get-Live $el $A::NativeWindowHandleProperty) + ' rect=' + (Get-Live $el $A::BoundingRectangleProperty) + ' rect(cached)=' + (Get-Cached $el $A::BoundingRectangleProperty)
  $line += ' value?=' + (Get-Live $el $A::IsValuePatternAvailableProperty) + '/' + (Get-Cached $el $A::IsValuePatternAvailableProperty)
  $line += ' invoke?=' + (Get-Live $el $A::IsInvokePatternAvailableProperty) + '/' + (Get-Cached $el $A::IsInvokePatternAvailableProperty)
  $line += ' focusable=' + (Get-Live $el $A::IsKeyboardFocusableProperty) + '/' + (Get-Cached $el $A::IsKeyboardFocusableProperty)
  $line += ' patterns=[' + (Get-Patterns $el) + ']'
  if ($null -ne $providerDescription) { $line += " provider='" + (Get-Live $el $providerDescription) + "'" }
  Out-Diag $line
  try { $child = $walker.GetFirstChild($el) } catch { Out-Diag (('  ' * $depth) + '  (children: ' + $_.Exception.GetType().Name + ')'); return }
  while ($null -ne $child) {
    Show-UiaNode $child ($depth + 1) $counter
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
}
function Find-Uia($root, [string]$name, $type) {
  $cond = New-Object System.Windows.Automation.AndCondition (
    (New-Object System.Windows.Automation.PropertyCondition ($A::NameProperty, $name)),
    (New-Object System.Windows.Automation.PropertyCondition ($A::ControlTypeProperty, $type)))
  try { return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond) } catch { Out-Diag ('FindFirst ' + $name + ': ' + $_.Exception.GetType().Name); return $null }
}
function Show-Msaa([long]$h, [string]$label, [int]$maxNodes) {
  # OBJID_CLIENT (0xFFFFFFFC) written in decimal: PowerShell reads a 32-bit hex literal as a negative int.
  foreach ($objid in @([uint32]4294967292, [uint32]0)) {
    $hr = 0
    $acc = [DiagMsaa]::Root($h, $objid, [ref]$hr)
    $which = if ($objid -eq 0) { 'OBJID_WINDOW' } else { 'OBJID_CLIENT' }
    if ($null -eq $acc) { Out-Diag ('MSAA ' + $label + ' ' + $which + ': none, hr=0x' + $hr.ToString('x8')); continue }
    Out-Diag ('MSAA ' + $label + ' ' + $which + ':')
    foreach ($l in [DiagMsaa]::Walk($acc, 14, $maxNodes)) { Out-Diag ('  ' + $l) }
  }
}

$root = $null
try { $root = $A::FromHandle([IntPtr]$Hwnd) } catch { Out-Diag ('FromHandle: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message) }
Out-Diag ('stage ' + $Stage + ', window ' + $Hwnd + ', PowerShell ' + $PSVersionTable.PSVersion + ', CLR ' + [Environment]::Version + ', ProviderDescription property ' + ($null -ne $providerDescription))

switch ($Stage) {
  'tree' {
    Out-Diag 'child windows:'
    foreach ($l in [DiagMsaa]::ChildWindows($Hwnd)) { Out-Diag ('  ' + $l) }
    if ($null -ne $root) {
      Out-Diag 'UIA control view (type name class framework hwnd rect value?=live/cached invoke?=live/cached focusable=live/cached patterns provider):'
      Show-UiaNode $root 0 @{ n = 0 }
      $field = Find-Uia $root 'Nom' ([System.Windows.Automation.ControlType]::Edit)
      if ($null -ne $field) {
        Start-Sleep -Milliseconds 1500
        Out-Diag ('field "Nom" 1.5 s later: value?=' + (Get-Live $field $A::IsValuePatternAvailableProperty) + '/' + (Get-Cached $field $A::IsValuePatternAvailableProperty) + ' patterns=[' + (Get-Patterns $field) + '] rect=' + (Get-Live $field $A::BoundingRectangleProperty))
        $fresh = Find-Uia $root 'Nom' ([System.Windows.Automation.ControlType]::Edit)
        if ($null -ne $fresh) { Out-Diag ('field "Nom" found again: value?=' + (Get-Live $fresh $A::IsValuePatternAvailableProperty) + ' patterns=[' + (Get-Patterns $fresh) + ']') }
      } else { Out-Diag 'FindFirst found no Edit named "Nom"' }
    }
    Show-Msaa $Hwnd 'window' 80
    foreach ($h in [DiagMsaa]::ChildHandles($Hwnd)) { Show-Msaa $h ('child ' + $h) 40 }
  }
  'uia-act' {
    if ($null -eq $root) { break }
    $field = Find-Uia $root 'Nom' ([System.Windows.Automation.ControlType]::Edit)
    if ($null -eq $field) { Out-Diag 'uia-act: no Edit named "Nom"' } else {
      $pattern = $null
      $ok = $false
      try { $ok = $field.TryGetCurrentPattern($VP::Pattern, [ref]$pattern) } catch { Out-Diag ('TryGetCurrentPattern(Value): ' + $_.Exception.GetType().Name) }
      Out-Diag ('field TryGetCurrentPattern(Value)=' + $ok)
      if ($ok) { try { $pattern.SetValue('uia'); Out-Diag ('ValuePattern.SetValue returned; Current.Value=' + $pattern.Current.Value) } catch { Out-Diag ('ValuePattern.SetValue: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message) } }
    }
    $button = Find-Uia $root 'Valider' ([System.Windows.Automation.ControlType]::Button)
    if ($null -eq $button) { Out-Diag 'uia-act: no Button named "Valider"' } else {
      $pattern = $null
      $ok = $false
      try { $ok = $button.TryGetCurrentPattern($IP::Pattern, [ref]$pattern) } catch { Out-Diag ('TryGetCurrentPattern(Invoke): ' + $_.Exception.GetType().Name) }
      Out-Diag ('button TryGetCurrentPattern(Invoke)=' + $ok)
      if ($ok) { try { $pattern.Invoke(); Out-Diag 'InvokePattern.Invoke returned' } catch { Out-Diag ('InvokePattern.Invoke: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message) } }
    }
  }
  'msaa-act' {
    $handles = @($Hwnd) + @([DiagMsaa]::ChildHandles($Hwnd))
    foreach ($h in $handles) {
      $hr = 0
      $acc = [DiagMsaa]::Root($h, [uint32]4294967292, [ref]$hr)
      if ($null -eq $acc) { Out-Diag ('msaa-act ' + $h + ': no root, hr=0x' + $hr.ToString('x8')); continue }
      Out-Diag ('msaa-act ' + $h + ' field: ' + [DiagMsaa]::Act($acc, 'Nom', 0x2A, 'msaa'))
      Out-Diag ('msaa-act ' + $h + ' button: ' + [DiagMsaa]::Act($acc, 'Valider', 0x2B, $null))
    }
  }
}
