param([Parameter(Mandatory = $true)][string]$Spec)

$ErrorActionPreference = 'Stop'
$maximumSpecBytes = 1048576
$expectedProperties = @('argv', 'cwd', 'env', 'exe', 'schemaVersion', 'statusPath', 'timeoutMs')

function Fail-Request([string]$Message) {
  throw [ArgumentException]::new($Message)
}

if ([string]::IsNullOrWhiteSpace($Spec) -or $Spec.Contains([char]0) -or [IO.Path]::GetFullPath($Spec) -ne $Spec) {
  Fail-Request 'Specification path must be absolute and NUL-free.'
}
$specPath = [IO.Path]::GetFullPath($Spec)
$specInfo = Get-Item -LiteralPath $specPath -Force
if (($specInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not ($specInfo -is [IO.FileInfo]) -or $specInfo.Length -le 0 -or $specInfo.Length -gt $maximumSpecBytes) {
  Fail-Request 'Specification file is unsafe or exceeds the size bound.'
}
$request = Get-Content -LiteralPath $specPath -Raw -Encoding UTF8 | ConvertFrom-Json
$properties = @($request.PSObject.Properties.Name | Sort-Object)
if (($properties -join "`0") -ne (($expectedProperties | Sort-Object) -join "`0")) { Fail-Request 'Specification fields are not exact.' }
if ($request.schemaVersion.GetType().FullName -notin @('System.Int32', 'System.Int64') -or [long]$request.schemaVersion -ne 1) { Fail-Request 'Specification schemaVersion is invalid.' }

foreach ($field in @('exe', 'cwd', 'statusPath')) {
  $value = [string]$request.$field
  if ([string]::IsNullOrWhiteSpace($value) -or $value.Contains([char]0) -or [IO.Path]::GetFullPath($value) -ne $value) {
    Fail-Request "Specification $field must be canonical, absolute, and NUL-free."
  }
}
if (-not [IO.File]::Exists([string]$request.exe) -or -not [IO.Directory]::Exists([string]$request.cwd)) { Fail-Request 'Specification executable or cwd does not exist.' }
$controlRoot = [IO.Path]::GetDirectoryName($specPath)
if ([IO.Path]::GetDirectoryName([string]$request.statusPath) -ne $controlRoot -or [IO.Path]::GetFileName([string]$request.statusPath) -ne 'status.json') {
  Fail-Request 'Status path is not the owned control status file.'
}
if ([IO.File]::Exists([string]$request.statusPath) -or [IO.Directory]::Exists([string]$request.statusPath)) { Fail-Request 'Status path already exists.' }
if ($request.timeoutMs.GetType().FullName -notin @('System.Int32', 'System.Int64') -or [long]$request.timeoutMs -lt 1000 -or [long]$request.timeoutMs -gt 900000) { Fail-Request 'Specification timeout is out of bounds.' }
if ($request.argv -is [string] -or $request.argv -isnot [System.Collections.IEnumerable]) { Fail-Request 'Specification argv must be an array.' }
$arguments = [Collections.Generic.List[string]]::new()
foreach ($argument in $request.argv) {
  if ($argument -isnot [string] -or $argument.Contains([char]0) -or $argument.Length -gt 32767) { Fail-Request 'Specification argument is invalid.' }
  $arguments.Add([string]$argument)
  if ($arguments.Count -gt 4096) { Fail-Request 'Specification has too many arguments.' }
}
if ($null -eq $request.env -or $request.env -is [string] -or $request.env -is [System.Collections.IEnumerable]) { Fail-Request 'Specification env must be an object.' }
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$environmentCharacters = 1
foreach ($property in $request.env.PSObject.Properties) {
  $name = [string]$property.Name
  if ([string]::IsNullOrEmpty($name) -or $name.Contains([char]0) -or $name.Contains('=') -or $property.Value -isnot [string] -or ([string]$property.Value).Contains([char]0)) {
    Fail-Request 'Specification environment is invalid.'
  }
  $value = [string]$property.Value
  $environmentCharacters += $name.Length + $value.Length + 2
  if ($environment.Count -ge 4096 -or $environmentCharacters -gt 32767) { Fail-Request 'Specification environment exceeds its bound.' }
  $environment.Add($name, $value)
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class TokenGraphJobRunner {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public uint dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }

  const uint CREATE_SUSPENDED = 0x00000004, CREATE_UNICODE_ENVIRONMENT = 0x00000400, CREATE_NO_WINDOW = 0x08000000, STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000, WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 0x00000102;
  const int JobObjectExtendedLimitInformation = 9, JobObjectBasicAccountingInformation = 1;
  const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int value);

  static Exception Win32(string action) { return new Win32Exception(Marshal.GetLastWin32Error(), action); }

  static string QuoteArgument(string value) {
    if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
      result.Append('\\', slashes).Append(character); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }

  static string EnvironmentBlock(IDictionary<string,string> environment) {
    var result = new StringBuilder();
    foreach (var pair in environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).ThenBy(pair => pair.Key, StringComparer.Ordinal)) {
      result.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
    }
    return result.Append('\0').ToString();
  }

  static bool DrainJob(IntPtr job, int durationMs, out uint activeProcesses) {
    var deadline = DateTime.UtcNow.AddMilliseconds(durationMs);
    do {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting, (uint)Marshal.SizeOf<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero)) throw Win32("QueryInformationJobObject failed");
      activeProcesses = accounting.ActiveProcesses;
      if (activeProcesses == 0) return true;
      System.Threading.Thread.Sleep(25);
    } while (DateTime.UtcNow < deadline);
    return false;
  }

  static string Status(string state, int childPid, uint? exitCode, bool forced, uint? activeProcesses, string errorCode) {
    return "{\"schemaVersion\":1,\"state\":\"" + state + "\",\"childPid\":" + childPid +
      ",\"exitCode\":" + (exitCode.HasValue ? exitCode.Value.ToString() : "null") +
      ",\"forced\":" + (forced ? "true" : "false") +
      ",\"activeProcesses\":" + (activeProcesses.HasValue ? activeProcesses.Value.ToString() : "null") +
      ",\"errorCode\":" + (errorCode == null ? "null" : "\"" + errorCode + "\"") + "}";
  }

  public static string Run(string application, string[] arguments, string cwd, IDictionary<string,string> environment, int timeoutMs) {
    IntPtr job = IntPtr.Zero, environmentPointer = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    bool created = false, assigned = false;
    uint? active = null;
    try {
      var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), dwFlags = STARTF_USESTDHANDLES, hStdInput = GetStdHandle(STD_INPUT_HANDLE), hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE), hStdError = GetStdHandle(STD_ERROR_HANDLE) };
      string commandLine = QuoteArgument(application) + (arguments.Length == 0 ? "" : " " + String.Join(" ", arguments.Select(QuoteArgument)));
      environmentPointer = Marshal.StringToHGlobalUni(EnvironmentBlock(environment));
      if (!CreateProcessW(application, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environmentPointer, cwd, ref si, out pi)) throw Win32("CREATE_PROCESS");
      created = true;
      job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw Win32("CREATE_JOB");
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())) throw Win32("CONFIGURE_JOB");
      if (!AssignProcessToJobObject(job, pi.hProcess)) throw Win32("ASSIGN_JOB"); assigned = true;
      if (ResumeThread(pi.hThread) == 0xffffffff) throw Win32("RESUME_PROCESS");
      uint waited = WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
      if (waited == WAIT_TIMEOUT) {
        if (!TerminateJobObject(job, 124)) throw Win32("TERMINATE_TIMEOUT_JOB");
        if (WaitForSingleObject(pi.hProcess, 30000) != WAIT_OBJECT_0) return Status("forced-failure", pi.dwProcessId, null, true, null, "TIMEOUT_EXIT_UNPROVEN");
        uint timeoutActive;
        if (!DrainJob(job, 30000, out timeoutActive)) return Status("forced-failure", pi.dwProcessId, null, true, timeoutActive, "TIMEOUT_DRAIN_UNPROVEN");
        return Status("forced-failure", pi.dwProcessId, null, true, timeoutActive, "TIMEOUT");
      }
      if (waited != WAIT_OBJECT_0) throw Win32("WAIT_PROCESS");
      uint exitCode, completedActive;
      if (!GetExitCodeProcess(pi.hProcess, out exitCode)) throw Win32("GET_EXIT_CODE");
      if (!DrainJob(job, 30000, out completedActive)) return Status("forced-failure", pi.dwProcessId, exitCode, true, completedActive, "DRAIN_UNPROVEN");
      active = completedActive;
      return Status("completed", pi.dwProcessId, exitCode, false, active, null);
    } catch (Exception error) {
      string errorCode = Regex.Replace(error.Message.Split(':')[0].ToUpperInvariant(), "[^A-Z0-9_]", "_");
      if (errorCode.Length > 128) errorCode = errorCode.Substring(0, 128);
      if (!created) return Status("forced-failure", 0, null, true, null, errorCode);
      bool terminated = assigned && job != IntPtr.Zero ? TerminateJobObject(job, 125) : TerminateProcess(pi.hProcess, 125);
      bool exited = WaitForSingleObject(pi.hProcess, 30000) == WAIT_OBJECT_0;
      if (!terminated) return Status("forced-failure", pi.dwProcessId, null, true, exited && !assigned ? (uint?)0 : null, assigned ? "TERMINATE_JOB_FAILED" : "TERMINATE_PROCESS_FAILED");
      if (!exited) return Status("forced-failure", pi.dwProcessId, null, true, null, "FORCED_EXIT_UNPROVEN");
      if (assigned && job != IntPtr.Zero) {
        uint forcedActive;
        try { if (!DrainJob(job, 30000, out forcedActive)) return Status("forced-failure", pi.dwProcessId, null, true, forcedActive, "FORCED_DRAIN_UNPROVEN"); active = forcedActive; }
        catch { return Status("forced-failure", pi.dwProcessId, null, true, null, "FORCED_QUERY_UNPROVEN"); }
      } else active = 0;
      return Status("forced-failure", pi.dwProcessId, null, true, active, errorCode);
    } finally {
      if (environmentPointer != IntPtr.Zero) Marshal.FreeHGlobal(environmentPointer);
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
'@

$status = [TokenGraphJobRunner]::Run([string]$request.exe, [string[]]$arguments.ToArray(), [string]$request.cwd, $environment, [int]$request.timeoutMs)
$statusBytes = [Text.UTF8Encoding]::new($false).GetBytes($status)
$stream = [IO.File]::Open([string]$request.statusPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $stream.Write($statusBytes, 0, $statusBytes.Length)
  $stream.Flush($true)
} finally {
  $stream.Dispose()
}
$parsed = $status | ConvertFrom-Json
if ($parsed.state -ne 'completed') { exit 125 }
exit [int]$parsed.exitCode
