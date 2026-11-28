import { WINDOWS_MSAA_LIB } from './computer-use-a11y-win32-msaa.js';

/**
 * The UI Automation half of the Windows accessibility backend, as PowerShell functions added to the
 * persistent input worker. Fixed text: a request (window handle, index path, action, value) arrives
 * as JSON and is only ever read as data, never spliced into a script or evaluated.
 *
 * The tree is walked in the Control view with a CacheRequest, so each element costs one cross-process
 * round trip instead of one per property. Ids are index paths from the window element.
 *
 * A Chromium web area (the child window of class Chrome_RenderWidgetHostHWND) is read through MSAA
 * whenever MSAA answers, even when UI Automation shows children. Up to Chromium 13x, UIA showed
 * nothing there; from the Chromium of Electron 45 it serves its own UIA tree, but a text field comes
 * back without ValuePattern, focusability or real bounds (CI run 46144862676), while MSAA still
 * offers set_value and press. MSAA also keeps the ids and actions the same across Chromium versions.
 */
export const WINDOWS_UIA_LIB = WINDOWS_MSAA_LIB + String.raw`
$script:uiaReady = $false
function Initialize-TimonUia {
  if ($script:uiaReady) { return }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -Namespace TimonUia -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern uint GetDpiForSystem();'
  # Aware, so UI Automation reports physical pixels; they are converted to points below.
  try { [void][TimonUia.Native]::SetProcessDPIAware() } catch { }
  $script:uiaScale = 1.0
  try { $dpi = [TimonUia.Native]::GetDpiForSystem(); if ($dpi -gt 0) { $script:uiaScale = $dpi / 96.0 } } catch { }
  $A = [System.Windows.Automation.AutomationElement]
  $cr = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::IsEnabledProperty, $A::BoundingRectangleProperty,
      $A::ClassNameProperty, $A::NativeWindowHandleProperty, $A::HasKeyboardFocusProperty, $A::IsKeyboardFocusableProperty, $A::IsPasswordProperty,
      $A::IsInvokePatternAvailableProperty, $A::IsValuePatternAvailableProperty, $A::IsTogglePatternAvailableProperty,
      $A::IsSelectionItemPatternAvailableProperty, $A::IsExpandCollapsePatternAvailableProperty, $A::IsScrollItemPatternAvailableProperty,
      [System.Windows.Automation.ValuePattern]::ValueProperty, [System.Windows.Automation.ValuePattern]::IsReadOnlyProperty,
      [System.Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty)) { $cr.Add($p) }
  $cr.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $script:uiaCache = $cr
  $script:uiaWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $script:uiaRaw = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $script:uiaReady = $true
}
function Get-TimonUiaRole($typeName) {
  switch ($typeName) {
    'ControlType.Button' { 'button' } 'ControlType.SplitButton' { 'button' }
    'ControlType.Edit' { 'textfield' } 'ControlType.Document' { 'textarea' }
    'ControlType.CheckBox' { 'checkbox' } 'ControlType.RadioButton' { 'radio' }
    'ControlType.ComboBox' { 'combobox' } 'ControlType.List' { 'list' }
    'ControlType.ListItem' { 'listitem' } 'ControlType.DataItem' { 'listitem' } 'ControlType.TreeItem' { 'listitem' }
    'ControlType.Menu' { 'menu' } 'ControlType.MenuItem' { 'menuitem' } 'ControlType.MenuBar' { 'menubar' }
    'ControlType.TabItem' { 'tab' } 'ControlType.Tab' { 'tablist' } 'ControlType.Hyperlink' { 'link' }
    'ControlType.Image' { 'image' } 'ControlType.Text' { 'text' }
    'ControlType.Group' { 'group' } 'ControlType.Pane' { 'group' } 'ControlType.Window' { 'window' }
    'ControlType.ToolBar' { 'toolbar' } 'ControlType.Table' { 'table' } 'ControlType.DataGrid' { 'table' } 'ControlType.Tree' { 'list' }
    'ControlType.Slider' { 'slider' } 'ControlType.ScrollBar' { 'scrollbar' }
    default { 'other' }
  }
}
# NotSupported is matched by reference: with -eq a boolean on the left converts the sentinel to $true,
# so every true property (IsInvokePatternAvailable, IsKeyboardFocusable, IsPassword...) read as absent.
function Get-TimonUiaCached($el, $property) {
  try { $v = $el.GetCachedPropertyValue($property); if ([object]::ReferenceEquals($v, [System.Windows.Automation.AutomationElement]::NotSupported)) { return $null }; return $v } catch { return $null }
}
function Get-TimonUiaActions($el) {
  $A = [System.Windows.Automation.AutomationElement]
  $actions = New-Object System.Collections.ArrayList
  if ((Get-TimonUiaCached $el $A::IsInvokePatternAvailableProperty) -eq $true -or (Get-TimonUiaCached $el $A::IsTogglePatternAvailableProperty) -eq $true) { [void]$actions.Add('press') }
  if ((Get-TimonUiaCached $el $A::IsKeyboardFocusableProperty) -eq $true) { [void]$actions.Add('focus') }
  if ((Get-TimonUiaCached $el $A::IsValuePatternAvailableProperty) -eq $true -and (Get-TimonUiaCached $el ([System.Windows.Automation.ValuePattern]::IsReadOnlyProperty)) -ne $true) { [void]$actions.Add('set_value') }
  if ((Get-TimonUiaCached $el $A::IsSelectionItemPatternAvailableProperty) -eq $true) { [void]$actions.Add('select') }
  if ((Get-TimonUiaCached $el $A::IsExpandCollapsePatternAvailableProperty) -eq $true) {
    $state = Get-TimonUiaCached $el ([System.Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty)
    if ($state -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) { [void]$actions.Add('expand') }
    if ($state -ne [System.Windows.Automation.ExpandCollapseState]::Collapsed -and $state -ne [System.Windows.Automation.ExpandCollapseState]::LeafNode) { [void]$actions.Add('collapse') }
  }
  if ((Get-TimonUiaCached $el $A::IsScrollItemPatternAvailableProperty) -eq $true) { [void]$actions.Add('scroll_into_view') }
  ,@($actions)
}
function Get-TimonUiaRoot($id) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]::Parse([string]$id))
    if ($null -eq $root) { return $null }
    return $root.GetUpdatedCache($script:uiaCache)
  } catch { return $null }
}
# Chromium (Chrome, Electron, VS Code, Slack) builds the web content's UI Automation tree only after a
# client has asked for it, and fills it a moment later. Its web area is the child window of class
# Chrome_RenderWidgetHostHWND (named "Chrome Legacy Window"): reading its first child is the ask, and
# it is read again for up to about 2 seconds while it is still empty. The Raw view is tried when the
# Control view shows nothing, since the MSAA bridge can mark its first elements as non-control.
function Get-TimonUiaFirstChild($el) {
  $child = $script:uiaWalker.GetFirstChild($el, $script:uiaCache)
  if ($null -ne $child) { return $child }
  $class = [string](Get-TimonUiaCached $el ([System.Windows.Automation.AutomationElement]::ClassNameProperty))
  if ($class -ne 'Chrome_RenderWidgetHostHWND' -and $class -notlike 'Chrome_WidgetWin_*') {
    return $null
  }
  for ($try = 0; $try -lt 4; $try++) {
    $child = $script:uiaWalker.GetFirstChild($el, $script:uiaCache)
    if ($null -eq $child) { $child = $script:uiaRaw.GetFirstChild($el, $script:uiaCache) }
    if ($null -ne $child) { return $child }
    Start-Sleep -Milliseconds 170
  }
  return $null
}
function Add-TimonUiaNode($el, [string]$path, [int]$depth, $state) {
  if ($state.nodes.Count -ge $state.maxNodes) { $state.truncated = $true; return }
  if ($depth -ge $state.maxDepth) { $state.truncated = $true; return }
  $A = [System.Windows.Automation.AutomationElement]
  $type = Get-TimonUiaCached $el $A::ControlTypeProperty
  $typeName = if ($null -ne $type) { $type.ProgrammaticName } else { '' }
  $role = Get-TimonUiaRole $typeName
  $name = [string](Get-TimonUiaCached $el $A::NameProperty)
  $node = @{ path = $path; role = $role; name = $name; enabled = ((Get-TimonUiaCached $el $A::IsEnabledProperty) -ne $false); actions = (Get-TimonUiaActions $el) }
  if ((Get-TimonUiaCached $el $A::IsPasswordProperty) -ne $true) {
    $value = Get-TimonUiaCached $el ([System.Windows.Automation.ValuePattern]::ValueProperty)
    if ($value -is [string] -and $value -ne '') { $node.value = $value }
  }
  if ((Get-TimonUiaCached $el $A::HasKeyboardFocusProperty) -eq $true) { $node.focused = $true }
  $rect = Get-TimonUiaCached $el $A::BoundingRectangleProperty
  if ($rect -is [System.Windows.Rect] -and -not $rect.IsEmpty) {
    $s = $script:uiaScale
    $node.bounds = @{ x = [math]::Round($rect.X / $s); y = [math]::Round($rect.Y / $s); width = [math]::Round($rect.Width / $s); height = [math]::Round($rect.Height / $s) }
  }
  [void]$state.nodes.Add($node)
  if ((Test-TimonChromiumWebArea $el) -and $state.nodes.Count -lt $state.maxNodes) {
    if (Add-TimonMsaaNodes $el $path $depth $state) { return }
  }
  $i = 0
  $child = Get-TimonUiaFirstChild $el
  while ($null -ne $child) {
    if ($state.nodes.Count -ge $state.maxNodes) { $state.truncated = $true; break }
    Add-TimonUiaNode $child ($path + '.' + $i) ($depth + 1) $state
    $i++
    $child = $script:uiaWalker.GetNextSibling($child, $script:uiaCache)
  }
  # UI Automation (UIA2) shows nothing under a Chromium web area: read it through MSAA instead.
  if ($i -eq 0 -and $state.nodes.Count -lt $state.maxNodes) { [void](Add-TimonMsaaNodes $el $path $depth $state) }
}
function Test-TimonChromiumWebArea($el) {
  [string](Get-TimonUiaCached $el ([System.Windows.Automation.AutomationElement]::ClassNameProperty)) -eq 'Chrome_RenderWidgetHostHWND'
}
# The MSAA element a UIA path designates past a web area: step k must be 0 (the MSAA root), the rest
# are MSAA child indices.
function Get-TimonMsaaTarget($msaa, $steps, [int]$k) {
  if ([int]$steps[$k] -ne 0) { return $null }
  $rest = New-Object System.Collections.ArrayList
  for ($m = $k + 1; $m -lt $steps.Length; $m++) { [void]$rest.Add([int]$steps[$m]) }
  return @{ msaaRoot = $msaa; steps = @($rest) }
}
function Get-TimonUiaElement($id, [string]$path) {
  $el = Get-TimonUiaRoot $id
  if ($null -eq $el) { return $null }
  $steps = $path.Split('.')
  for ($k = 1; $k -lt $steps.Length; $k++) {
    $want = [int]$steps[$k]
    # The same choice as the walk: a Chromium web area whose MSAA root answers is an MSAA path.
    if (Test-TimonChromiumWebArea $el) {
      $msaa = Get-TimonMsaaRoot $el
      if ($null -ne $msaa) { return (Get-TimonMsaaTarget $msaa $steps $k) }
    }
    $first = Get-TimonUiaFirstChild $el
    if ($null -eq $first) {
      # No UIA children: the rest of the path, if any, is an MSAA path under this web area.
      $msaa = Get-TimonMsaaRoot $el
      if ($null -eq $msaa) { return $null }
      return (Get-TimonMsaaTarget $msaa $steps $k)
    }
    $el = $first
    for ($j = 0; $j -lt $want -and $null -ne $el; $j++) { $el = $script:uiaWalker.GetNextSibling($el, $script:uiaCache) }
    if ($null -eq $el) { return $null }
  }
  return $el
}
function Invoke-TimonUiaTree($q) {
  Initialize-TimonUia
  $root = Get-TimonUiaRoot $q.id
  if ($null -eq $root) { return @{ stale = $true } }
  $state = @{ nodes = (New-Object System.Collections.ArrayList); truncated = $false; maxDepth = [int]$q.maxDepth; maxNodes = [int]$q.maxNodes }
  Add-TimonUiaNode $root '0' 0 $state
  return @{ truncated = $state.truncated; nodes = @($state.nodes) }
}
function Invoke-TimonUiaAct($q) {
  Initialize-TimonUia
  $el = Get-TimonUiaElement $q.id ([string]$q.path)
  if ($null -eq $el) { return @{ stale = $true } }
  if ($el -is [hashtable]) { return Invoke-TimonMsaaAct $q $el.msaaRoot $el.steps }
  $possible = Get-TimonUiaActions $el
  $unsupported = @{ unsupported = $true; actions = @($possible) }
  try {
    switch ($q.action) {
      'press' {
        if ($possible -notcontains 'press') { return $unsupported }
        $pattern = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke() }
        elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle() }
        else { return $unsupported }
      }
      'focus' { if ($possible -notcontains 'focus') { return $unsupported }; $el.SetFocus() }
      'set_value' {
        if ($possible -notcontains 'set_value') { return $unsupported }
        $pattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $pattern.SetValue([string]$q.value)
      }
      'select' { if ($possible -notcontains 'select') { return $unsupported }; $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
      'expand' { if ($possible -notcontains 'expand') { return $unsupported }; $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() }
      'collapse' { if ($possible -notcontains 'collapse') { return $unsupported }; $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() }
      'scroll_into_view' { if ($possible -notcontains 'scroll_into_view') { return $unsupported }; $el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() }
      default { return $unsupported }
    }
  } catch [System.Windows.Automation.ElementNotAvailableException] { return @{ stale = $true } }
  return @{ ok = $true }
}
`;
