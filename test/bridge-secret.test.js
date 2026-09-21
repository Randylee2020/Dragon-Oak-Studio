const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertSiteMaySeeSecret, defaultSecretFile, parseTrustedHost, redact, resolveBridgeSecret } = require("../tools/bridge-secret");

// Test-only values. Not the production secret.
const SECRET = "Zk3-test-only-secret-0123456789-abcdefghijklmnop";
const OTHER_SECRET = "Qq9-another-test-only-secret-9876543210-zyxwvutsrq";
const POSIX = process.platform !== "win32";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "do-secret-"));
const writeSecretFile = (dir, name, content, mode = 0o600) => {
  const file = path.join(dir, name);

  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);

  return file;
};
// repoRoot points at a folder that is not the real repository, so temp files count as "outside the repo".
const resolve = (env, extra = {}) => resolveBridgeSecret({ env, homedir: tempDir(), repoRoot: path.join(os.tmpdir(), "not-the-repository"), ...extra });

test("the secret is taken from ADRIAN's environment when it is there (nobody types it)", () => {
  const result = resolve({ ADRIAN_BRIDGE_SECRET: `${SECRET}\n` });

  assert.equal(result.secret, SECRET);
  assert.equal(result.source, "environment variable ADRIAN_BRIDGE_SECRET");
  assert.ok(!result.source.includes(SECRET), "the source description never contains the value");
});

test("the secret can come from a private file named by ADRIAN_BRIDGE_SECRET_FILE (trailing newline and BOM are ignored)", () => {
  const dir = tempDir();
  const file = writeSecretFile(dir, "secret.txt", `${String.fromCharCode(0xfeff)}${SECRET}\r\n`);
  const result = resolve({ ADRIAN_BRIDGE_SECRET_FILE: file });

  assert.equal(result.secret, SECRET);
  assert.ok(!result.source.includes(SECRET));
});

test("with nothing configured it falls back to <home>/.adrian/bridge-secret", () => {
  const home = tempDir();

  fs.mkdirSync(path.join(home, ".adrian"));
  writeSecretFile(path.join(home, ".adrian"), "bridge-secret", SECRET);

  const result = resolve({}, { homedir: home, platform: "linux" });

  assert.equal(result.secret, SECRET);
  assert.equal(defaultSecretFile(home), path.join(home, ".adrian", "bridge-secret"));
});

test("the environment variable wins over a file, and an explicitly named file that fails never falls back to another source", () => {
  const home = tempDir();

  fs.mkdirSync(path.join(home, ".adrian"));
  writeSecretFile(path.join(home, ".adrian"), "bridge-secret", OTHER_SECRET);

  const dir = tempDir();
  const file = writeSecretFile(dir, "secret.txt", SECRET);

  assert.equal(resolve({ ADRIAN_BRIDGE_SECRET: SECRET, ADRIAN_BRIDGE_SECRET_FILE: file }, { homedir: home }).secret, SECRET);
  assert.throws(() => resolve({ ADRIAN_BRIDGE_SECRET_FILE: path.join(dir, "missing.txt") }, { homedir: home }), /could not be found or opened/);
});

test("when no secret is available the error explains where to put it and contains no secret", () => {
  assert.throws(
    () => resolve({}, { platform: "linux" }),
    (error) =>
      /ADRIAN_BRIDGE_SECRET environment variable/.test(error.message) &&
      /ADRIAN_BRIDGE_SECRET_FILE/.test(error.message) &&
      /\.adrian/.test(error.message) &&
      /never asks you to type it/.test(error.message)
  );
});

test("a secret file readable by other users is refused (macOS/Linux)", { skip: !POSIX }, () => {
  const file = writeSecretFile(tempDir(), "secret.txt", SECRET, 0o644);

  assert.throws(
    () => resolve({ ADRIAN_BRIDGE_SECRET_FILE: file }),
    (error) => /can be read by other users/.test(error.message) && !error.message.includes(SECRET)
  );
});

test("a secret file inside the Git repository is refused so it can never be committed", () => {
  const repo = tempDir();
  const file = writeSecretFile(repo, "bridge-secret", SECRET);

  assert.throws(
    () => resolveBridgeSecret({ env: { ADRIAN_BRIDGE_SECRET_FILE: file }, homedir: tempDir(), repoRoot: repo }),
    (error) => /inside the Git repository/.test(error.message) && !error.message.includes(SECRET)
  );
});

test("bad secret values are refused with a helpful message that never repeats the value", () => {
  const dir = tempDir();
  const bad = {
    empty: "  \n",
    tooShort: "short-but-real-looking-secret",
    hasSpace: `${SECRET} extra-words-after-it`,
    twoLines: `${SECRET}\n${OTHER_SECRET}`,
    // What Windows PowerShell's ">" produces: UTF-16 with NUL bytes between the characters.
    utf16: Buffer.from(SECRET, "utf16le").toString("latin1"),
    huge: "A".repeat(600),
  };

  Object.entries(bad).forEach(([name, content]) => {
    assert.throws(
      () => resolve({ ADRIAN_BRIDGE_SECRET: content }),
      (error) => !error.message.includes(SECRET) && !error.message.includes(OTHER_SECRET) && !error.message.includes(content.trim() || "no-such-text"),
      `environment: ${name}`
    );

    const file = writeSecretFile(dir, `${name}.txt`, content);

    assert.throws(
      () => resolve({ ADRIAN_BRIDGE_SECRET_FILE: file }),
      (error) => !error.message.includes(SECRET) && !error.message.includes(OTHER_SECRET),
      `file: ${name}`
    );
  });
});

test("the secret is only sent to trusted hosts unless a host is named explicitly", () => {
  ["https://dragonoakstudio.com", "https://www.dragonoakstudio.com/", "http://localhost:3000", "http://127.0.0.1:8123"].forEach((site) =>
    assert.doesNotThrow(() => assertSiteMaySeeSecret(site, []), site)
  );

  [
    "https://evil.example",
    "https://dragonoakstudio.com.evil.example",
    "https://evil-dragonoakstudio.com",
    "https://dragonoakstudio.co",
    "https://shop.dragonoakstudio.com", // subdomains are not assumed to be ours
  ].forEach((site) => assert.throws(() => assertSiteMaySeeSecret(site, []), /Refusing to send the bridge secret/, site));

  const preview = "dragon-oak-studio-git-storefront-v1-team.vercel.app";

  assert.equal(assertSiteMaySeeSecret(`https://${preview}`, [preview]), preview);
  assert.throws(() => assertSiteMaySeeSecret("https://other-project.vercel.app", [preview]), /Refusing/);
  assert.throws(() => assertSiteMaySeeSecret("not a url", []), /full web address/);
});

test("--trust-host takes one exact host name, not a wildcard, address or path", () => {
  assert.equal(parseTrustedHost("My-Preview.vercel.app"), "my-preview.vercel.app");

  ["*.vercel.app", "https://x.vercel.app", "x.vercel.app/path", "", "a..b", "x y", "-bad.example"].forEach((value) =>
    assert.throws(() => parseTrustedHost(value), /exact host name/, JSON.stringify(value))
  );
});

test("redact removes the secret from any text that echoes it", () => {
  assert.equal(redact(`server said: ${SECRET}!`, SECRET), "server said: [redacted]!");
  assert.equal(redact("nothing to hide", SECRET), "nothing to hide");
  assert.equal(redact("nothing to hide", null), "nothing to hide");
});

// ---- Windows: the secret lives in Windows' own protected storage (DPAPI), not in a plain-text file ------------------------------
// These run on any OS by passing platform: "win32" and a fake PowerShell launcher. They prove OUR side (which file, which
// program, what is and is not passed to it). They cannot prove Windows itself unlocks the file; that needs a real Windows PC.

const { WINDOWS_READ_SCRIPT, defaultWindowsProtectedFile } = require("../tools/bridge-secret");

const WIN_HOME = "C:\\Users\\Randy";
const WIN_ENV = { LOCALAPPDATA: "C:\\Users\\Randy\\AppData\\Local", SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" };
const WIN_FILE = "C:\\Users\\Randy\\AppData\\Local\\ADRIAN\\bridge-secret.dpapi";
const WIN_PLAINTEXT = "C:\\Users\\Randy\\.adrian\\bridge-secret";

const winResolve = (env, { files = [WIN_FILE], exec = () => `${SECRET}\r\n` } = {}) => {
  const calls = [];
  const result = () =>
    resolveBridgeSecret({
      env,
      homedir: WIN_HOME,
      platform: "win32",
      fsImpl: { existsSync: (file) => files.includes(file) },
      execFileSyncImpl: (...args) => {
        calls.push(args);
        return exec(...args);
      },
    });

  return { calls, result };
};

test("Windows: the secret is unlocked from the DPAPI-protected file by Windows PowerShell, with nothing secret on any command line", () => {
  const { calls, result } = winResolve({ ...WIN_ENV, ADRIAN_BRIDGE_SECRET_FILE: undefined });
  const resolved = result();

  assert.equal(resolved.secret, SECRET);
  assert.ok(resolved.source.includes("Windows protected storage") && resolved.source.includes(WIN_FILE));
  assert.ok(!resolved.source.includes(SECRET));
  assert.equal(calls.length, 1);

  const [program, args, options] = calls[0];

  assert.equal(program, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "started by full path, so a look-alike program earlier on PATH cannot be picked up");
  assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_READ_SCRIPT]);
  assert.ok(!args.join(" ").includes(SECRET) && !args.join(" ").includes(WIN_FILE), "neither the secret nor the file path is spliced into the command line");
  assert.ok(!options.shell, "no shell is involved, so nothing can be injected");
  assert.equal(options.stdio[2], "ignore", "PowerShell's error text is discarded");
  assert.equal(options.env.ADRIAN_PROTECTED_SECRET_FILE, WIN_FILE);
  assert.ok(!("ADRIAN_BRIDGE_SECRET" in options.env) && !("ADRIAN_BRIDGE_SECRET_FILE" in options.env), "the child never receives other secret settings");
});

test("Windows: the plain-text ~/.adrian/bridge-secret file is NOT used, even when it exists", () => {
  const { calls, result } = winResolve(WIN_ENV, { files: [WIN_PLAINTEXT] });

  assert.throws(result, (error) => /Windows protected storage/.test(error.message) && /bridge-secret\.dpapi/.test(error.message) && !/\.adrian/.test(error.message) && !error.message.includes(SECRET));
  assert.equal(calls.length, 0);
});

test("Windows: the environment variable still wins, and PowerShell is not started", () => {
  const { calls, result } = winResolve({ ...WIN_ENV, ADRIAN_BRIDGE_SECRET: SECRET });

  assert.equal(result().secret, SECRET);
  assert.equal(calls.length, 0);
});

test("Windows: if Windows cannot unlock the file, one generic message is shown and nothing PowerShell said leaks", () => {
  const leaky = () => {
    const error = new Error(`Command failed: powershell ... ${SECRET}`);

    error.stderr = `Key not valid for use in specified state. ${SECRET}`;
    error.stdout = SECRET;
    throw error;
  };
  const { result } = winResolve(WIN_ENV, { exec: leaky });

  assert.throws(result, (error) => /could not unlock the protected bridge secret/.test(error.message) && error.message.includes(WIN_FILE) && !error.message.includes(SECRET) && !/Key not valid/.test(error.message));
});

test("Windows: unusable output from the unlock step is refused without repeating it", () => {
  ["", "   \r\n", "too-short", `${SECRET} ${OTHER_SECRET}`, "A".repeat(600)].forEach((output) => {
    const { result } = winResolve(WIN_ENV, { exec: () => output });

    assert.throws(result, (error) => !error.message.includes(SECRET) && !error.message.includes(OTHER_SECRET) && !error.message.includes(output.trim() || "no-such-text"), JSON.stringify(output.slice(0, 12)));
  });
});

test("the Windows unlock step is never used on other systems", () => {
  const calls = [];

  assert.throws(() => resolveBridgeSecret({ env: { ...WIN_ENV }, homedir: tempDir(), platform: "linux", fsImpl: { existsSync: () => true }, execFileSyncImpl: (...args) => calls.push(args) }));
  assert.equal(calls.length, 0);
});

test("the Windows unlock script only reads: DPAPI cmdlets, no key, no plain-text conversion, no writing, no network, no extra programs", () => {
  assert.match(WINDOWS_READ_SCRIPT, /ConvertTo-SecureString -String \$encrypted/);
  assert.ok(WINDOWS_READ_SCRIPT.includes("$env:ADRIAN_PROTECTED_SECRET_FILE"), "the path comes from the environment");
  assert.ok(!/[A-Za-z]:\\/.test(WINDOWS_READ_SCRIPT), "no path is written into the script");

  ["-Key", "-AsPlainText", "Set-Content", "Out-File", "Add-Content", "New-Item", "Remove-Item", "Invoke-", "Start-Process", "WebClient", "Net.", "Write-Host", "Write-Output", "Export-", "Tee-Object"].forEach((forbidden) =>
    assert.ok(!WINDOWS_READ_SCRIPT.includes(forbidden), `the script must not contain ${forbidden}`)
  );
});

test("the protected file lives in the user's local app data (with a sensible fallback)", () => {
  assert.equal(defaultWindowsProtectedFile(WIN_ENV, WIN_HOME), WIN_FILE);
  assert.equal(defaultWindowsProtectedFile({}, WIN_HOME), "C:\\Users\\Randy\\AppData\\Local\\ADRIAN\\bridge-secret.dpapi");
});
