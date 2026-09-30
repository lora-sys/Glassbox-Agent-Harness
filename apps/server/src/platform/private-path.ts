import { execFile as execFileCallback } from "node:child_process";
import { chmod } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const setPrivateAcl = `
$ErrorActionPreference = 'Stop'
$path = $env:GLASSBOX_PRIVATE_PATH
$directory = $env:GLASSBOX_PRIVATE_DIRECTORY -eq '1'
$acl = if ($directory) { [System.IO.Directory]::GetAccessControl($path) }
       else { [System.IO.File]::GetAccessControl($path) }
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.PurgeAccessRules($rule.IdentityReference) }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = if ($directory) {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else { [System.Security.AccessControl.InheritanceFlags]::None }
$grant = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($grant)
if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl) }
else { [System.IO.File]::SetAccessControl($path, $acl) }
`;

/** Restrict an existing private file or directory to the current Windows user. */
export async function securePrivatePath(path: string, directory: boolean): Promise<void> {
  await chmod(path, directory ? 0o700 : 0o600);
  if (process.platform !== "win32") return;

  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("private_path_acl_unavailable");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", setPrivateAcl], {
    windowsHide: true,
    env: {
      ...process.env,
      GLASSBOX_PRIVATE_PATH: path,
      GLASSBOX_PRIVATE_DIRECTORY: directory ? "1" : "0",
    },
  });
}
