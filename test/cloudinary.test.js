const test = require("node:test");
const assert = require("node:assert/strict");

const { createSignedUpload, signUploadParams, getCloudinaryConfig } = require("../api/_lib/cloudinary");

const withCloudinaryEnv = (env, run) => {
  const keys = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  const original = {};
  for (const key of keys) {
    original[key] = process.env[key];
  }
  for (const key of keys) {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
};

test("getCloudinaryConfig reports not-ok when any env var is missing", () => {
  withCloudinaryEnv({ CLOUDINARY_CLOUD_NAME: "demo" }, () => {
    assert.deepEqual(getCloudinaryConfig(), { ok: false });
  });
});

test("getCloudinaryConfig returns config when all env vars are present", () => {
  withCloudinaryEnv(
    { CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key123", CLOUDINARY_API_SECRET: "secret456" },
    () => {
      const config = getCloudinaryConfig();
      assert.equal(config.ok, true);
      assert.equal(config.cloudName, "demo");
      assert.equal(config.apiKey, "key123");
      assert.equal(config.apiSecret, "secret456");
    }
  );
});

test("signUploadParams is deterministic for the same params/secret and order-independent", () => {
  const a = signUploadParams({ folder: "x", public_id: "y", timestamp: "1" }, "secret");
  const b = signUploadParams({ timestamp: "1", folder: "x", public_id: "y" }, "secret");
  assert.equal(a, b);
});

test("signUploadParams changes when any param or secret changes", () => {
  const base = signUploadParams({ folder: "x", public_id: "y", timestamp: "1" }, "secret");
  const differentFolder = signUploadParams({ folder: "z", public_id: "y", timestamp: "1" }, "secret");
  const differentSecret = signUploadParams({ folder: "x", public_id: "y", timestamp: "1" }, "other");
  assert.notEqual(base, differentFolder);
  assert.notEqual(base, differentSecret);
});

test("createSignedUpload returns ok:false when Cloudinary is not configured", () => {
  withCloudinaryEnv({}, () => {
    const result = createSignedUpload({ fileName: "x.zip", resourceType: "raw", folder: "dragon-oak/etsy-digital-files" });
    assert.equal(result.ok, false);
    assert.match(result.error, /not configured/);
  });
});

test("createSignedUpload appends the extension to publicId for raw uploads only", () => {
  withCloudinaryEnv(
    { CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key123", CLOUDINARY_API_SECRET: "secret456" },
    () => {
      const rawResult = createSignedUpload({ fileName: "set01.zip", resourceType: "raw", folder: "f" });
      assert.match(rawResult.publicId, /\.zip$/);

      const imageResult = createSignedUpload({ fileName: "preview.png", resourceType: "image", folder: "f" });
      assert.ok(!imageResult.publicId.endsWith(".png"));
    }
  );
});

test("createSignedUpload returns a signature matching signUploadParams over its own uploadParams", () => {
  withCloudinaryEnv(
    { CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key123", CLOUDINARY_API_SECRET: "secret456" },
    () => {
      const result = createSignedUpload({ fileName: "set01.zip", resourceType: "raw", folder: "dragon-oak/etsy-digital-files" });
      const expected = signUploadParams(
        { folder: result.folder, public_id: result.publicId, timestamp: result.timestamp },
        "secret456"
      );
      assert.equal(result.signature, expected);
      assert.equal(result.resourceType, "raw");
      assert.equal(result.folder, "dragon-oak/etsy-digital-files");
    }
  );
});
