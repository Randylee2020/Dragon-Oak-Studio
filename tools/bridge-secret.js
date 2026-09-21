// How ADRIAN / local automation gets the bridge secret WITHOUT a person copying it, and where it is allowed to be sent.
//
// The secret (ADRIAN_BRIDGE_SECRET) already lives on the server (Vercel). The machine running ADRIAN needs the same value
// once, in ADRIAN's own private configuration. This module finds it there, in this order:
//
//   1. the ADRIAN_BRIDGE_SECRET environment variable of the process running the command
//      (ADRIAN sets this for the child process; nobody types it)
//   2. a file whose path is in ADRIAN_BRIDGE_SECRET_FILE
//   3. macOS/Linux: the file  <home folder>/.adrian/bridge-secret  (readable only by its owner)
//      Windows:     %LOCALAPPDATA%\ADRIAN\bridge-secret.dpapi  -- encrypted by Windows itself (DPAPI) for the current
//                   Windows user, so the file is useless if it is copied, committed, backed up, or read by another user.
//                   The plain-text home-folder file is deliberately NOT used on Windows.
//
// Rules that keep it secret:
//   - It can NEVER be passed on the command line (visible in process lists and shell history).
//   - A secret file must be a small plain-text file, outside this Git repository, and (on macOS/Linux) readable only by
//     its owner. Windows has no owner-only check for plain-text files, which is why Windows uses the DPAPI file instead;
//     ADRIAN_BRIDGE_SECRET_FILE still works there but is not recommended.
//   - Errors describe the problem and the file's location. They never contain the secret or any part of it.
//   - The secret is only ever sent to a host on the trusted list (or one named explicitly with --trust-host), so a
//     mistyped or hostile --site cannot receive it.
//
// This module never writes anything.
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SECRET_ENV_NAME = "ADRIAN_BRIDGE_SECRET";
const SECRET_FILE_ENV_NAME = "ADRIAN_BRIDGE_SECRET_FILE";
// Same minimum as api/_lib/bridge-auth.js: the server rejects anything shorter, so failing early saves a confusing 503.
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 512;
const MAX_SECRET_FILE_BYTES = 4096;
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const WINDOWS_PROTECTED_FILE_NAME = "bridge-secret.dpapi";
// The one and only thing run on Windows: read the DPAPI-protected file and print the secret to this process's pipe. The file
// path arrives in an environment variable (never spliced into this text), nothing is written anywhere, there is no -Key (so
// Windows itself holds the key), and stderr is discarded by the caller.
const WINDOWS_READ_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$encrypted=(Get-Content -LiteralPath $env:ADRIAN_PROTECTED_SECRET_FILE -Raw).Trim()",
  "$secure=ConvertTo-SecureString -String $encrypted",
  "$bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
  "try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}",
].join(";");
const TRUSTED_HOSTS = ["dragonoakstudio.com", "www.dragonoakstudio.com", "localhost", "127.0.0.1"];
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

const defaultSecretFile = (homedir) => path.join(homedir, ".adrian", "bridge-secret");

// Accepts printable ASCII only (0x21-0x7E). That excludes spaces, line breaks, control characters and the NUL bytes a
// UTF-16 file produces, and it makes the value safe to place in an HTTP header.
const cleanSecret = (raw, where) => {
  // trim() also removes a leading byte-order mark and the trailing line break most editors add.
  const value = String(raw).trim();

  if (!value) {
    throw new Error(`${where} is empty.`);
  }

  if (/[^\x21-\x7e]/.test(value)) {
    throw new Error(`${where} has spaces, line breaks or unreadable characters in it. Save it as plain text (UTF-8, not UTF-16) with only the secret on a single line.`);
  }

  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${where} is shorter than ${MIN_SECRET_LENGTH} characters, so the bridge would reject it. Check that the whole secret was saved.`);
  }

  if (value.length > MAX_SECRET_LENGTH) {
    throw new Error(`${where} is longer than ${MAX_SECRET_LENGTH} characters, which is not a valid bridge secret.`);
  }

  return value;
};

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const readSecretFile = (filePath, { fsImpl, platform, uid, repoRoot }) => {
  let resolved;

  try {
    resolved = fsImpl.realpathSync(filePath);
  } catch {
    throw new Error(`The bridge secret file ${filePath} could not be found or opened.`);
  }

  let repoReal = repoRoot;

  try {
    repoReal = fsImpl.realpathSync(repoRoot);
  } catch {
    // Keep the unresolved path; the comparison below still works for the common case.
  }

  if (isInside(repoReal, resolved)) {
    throw new Error(`The bridge secret file ${filePath} is inside the Git repository. Keep it outside the project folder so it can never be committed.`);
  }

  const stat = fsImpl.statSync(resolved);

  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(`The bridge secret file ${filePath} must be a small, non-empty text file.`);
  }

  if (platform !== "win32") {
    if (typeof uid === "number" && stat.uid !== uid) {
      throw new Error(`The bridge secret file ${filePath} must belong to the user running this command.`);
    }

    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`The bridge secret file ${filePath} can be read by other users. Restrict it first (on macOS/Linux: chmod 600 "${filePath}").`);
    }
  }

  return cleanSecret(fsImpl.readFileSync(resolved, "utf8"), `The bridge secret file ${filePath}`);
};

const defaultWindowsProtectedFile = (env, homedir) => path.win32.join(env.LOCALAPPDATA || path.win32.join(homedir, "AppData", "Local"), "ADRIAN", WINDOWS_PROTECTED_FILE_NAME);

// Windows only. Asks Windows PowerShell (started by full path, without a shell) to unlock the DPAPI file. The secret comes back
// over a pipe; it is never on a command line. Any failure becomes one generic message, so no PowerShell output can leak.
const readWindowsProtectedSecret = (file, { env, execFileSyncImpl }) => {
  const childEnv = { ...env, ADRIAN_PROTECTED_SECRET_FILE: file };

  delete childEnv[SECRET_ENV_NAME];
  delete childEnv[SECRET_FILE_ENV_NAME];

  const powershell = path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let output;

  try {
    output = execFileSyncImpl(powershell, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_READ_SCRIPT], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: childEnv,
    });
  } catch {
    throw new Error(`Windows could not unlock the protected bridge secret ${file}. Only the same Windows user, on the same PC that saved it, can open it. Save it again there (see catalog/README.md).`);
  }

  return cleanSecret(output, "The protected bridge secret");
};

// Returns { secret, source } where `source` names WHERE the secret came from (never the value).
const resolveBridgeSecret = ({
  env = process.env,
  homedir = os.homedir(),
  fsImpl = fs,
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  repoRoot = REPOSITORY_ROOT,
  execFileSyncImpl = childProcess.execFileSync,
} = {}) => {
  const fileOptions = { fsImpl, platform, uid, repoRoot };

  if (env[SECRET_ENV_NAME]) {
    return { secret: cleanSecret(env[SECRET_ENV_NAME], `The ${SECRET_ENV_NAME} environment variable`), source: `environment variable ${SECRET_ENV_NAME}` };
  }

  // A file that was named explicitly must work. It never quietly falls back to another source.
  if (env[SECRET_FILE_ENV_NAME]) {
    return { secret: readSecretFile(env[SECRET_FILE_ENV_NAME], fileOptions), source: `secret file from ${SECRET_FILE_ENV_NAME}` };
  }

  if (platform === "win32") {
    const protectedFile = defaultWindowsProtectedFile(env, homedir);

    if (fsImpl.existsSync(protectedFile)) {
      return { secret: readWindowsProtectedSecret(protectedFile, { env, execFileSyncImpl }), source: `Windows protected storage ${protectedFile}` };
    }

    throw new Error(
      [
        "No bridge secret is available to this command. Give it to ADRIAN once, in ADRIAN's own private setup, in ONE of these places",
        "(this tool never asks you to type it, and never prints or saves it):",
        `  1. the ${SECRET_ENV_NAME} environment variable of the process that runs this command`,
        `  2. Windows protected storage: ${protectedFile}  (one-time setup steps: catalog/README.md)`,
        `  3. a plain-text file whose path is in ${SECRET_FILE_ENV_NAME}  (works, but not recommended on Windows)`,
      ].join("\n")
    );
  }

  const fallback = defaultSecretFile(homedir);

  if (fsImpl.existsSync(fallback)) {
    return { secret: readSecretFile(fallback, fileOptions), source: `secret file ${fallback}` };
  }

  throw new Error(
    [
      "No bridge secret is available to this command. Give it to ADRIAN once, in ADRIAN's own private setup, in ONE of these places",
      "(this tool never asks you to type it, and never prints or saves it):",
      `  1. the ${SECRET_ENV_NAME} environment variable of the process that runs this command`,
      `  2. a plain-text file whose path is in ${SECRET_FILE_ENV_NAME}`,
      `  3. the file ${fallback}`,
    ].join("\n")
  );
};

// The secret is only sent to hosts we trust. Anything else must be named explicitly with --trust-host <exact host name>.
const parseTrustedHost = (value) => {
  const host = String(value || "").trim().toLowerCase();

  if (!HOSTNAME_PATTERN.test(host) || host.includes("..")) {
    throw new Error("--trust-host needs one exact host name such as my-preview.vercel.app (no https://, no path, no wildcard).");
  }

  return host;
};

const assertSiteMaySeeSecret = (site, trustHosts = []) => {
  let host;

  try {
    host = new URL(site).hostname.toLowerCase();
  } catch {
    throw new Error("--site must be a full web address, for example https://dragonoakstudio.com");
  }

  const allowed = new Set([...TRUSTED_HOSTS, ...trustHosts.map(parseTrustedHost)]);

  if (!allowed.has(host)) {
    throw new Error(
      `Refusing to send the bridge secret to ${host}. It is only sent to ${TRUSTED_HOSTS.slice(0, 2).join(" and ")}. ` +
        `If ${host} really is your storefront-v1 preview, repeat the command with:  --trust-host ${host}`
    );
  }

  return host;
};

// Belt and braces: if anything ever echoes the secret back (for example an error page that repeats a request header), it is
// removed before the text reaches a screen, a log or a report.
const redact = (text, secret) => (secret ? String(text).split(secret).join("[redacted]") : String(text));

module.exports = {
  MIN_SECRET_LENGTH,
  SECRET_ENV_NAME,
  SECRET_FILE_ENV_NAME,
  TRUSTED_HOSTS,
  assertSiteMaySeeSecret,
  WINDOWS_READ_SCRIPT,
  defaultSecretFile,
  defaultWindowsProtectedFile,
  parseTrustedHost,
  redact,
  resolveBridgeSecret,
};
