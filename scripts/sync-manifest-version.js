/**
 * sync-manifest-version.js
 *
 * Reads the version from package.json and updates:
 *   1. The <Version> element in manifest.xml and manifest.dev.xml
 *   2. The version display in src/taskpane/taskpane.html
 *
 * Office manifest uses 4-segment versioning (e.g. 1.2.3.0),
 * so we append ".0" to the semver 3-segment version.
 *
 * Called automatically by the npm `version` lifecycle hook.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const semver = pkg.version; // e.g. "1.2.3"
const officeVersion = `${semver}.0`; // e.g. "1.2.3.0"

// --- Update manifest.xml ---
const manifestPath = path.join(root, 'manifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
manifest = manifest.replace(
  /<Version>[^<]+<\/Version>/,
  `<Version>${officeVersion}</Version>`,
);
fs.writeFileSync(manifestPath, manifest, 'utf8');
console.log(`✓ manifest.xml version updated to ${officeVersion}`);

// --- Update manifest.dev.xml ---
const devManifestPath = path.join(root, 'manifest.dev.xml');
if (fs.existsSync(devManifestPath)) {
  let devManifest = fs.readFileSync(devManifestPath, 'utf8');
  devManifest = devManifest.replace(
    /<Version>[^<]+<\/Version>/,
    `<Version>${officeVersion}</Version>`,
  );
  fs.writeFileSync(devManifestPath, devManifest, 'utf8');
  console.log(`✓ manifest.dev.xml version updated to ${officeVersion}`);
}

// --- Update taskpane.html version display ---
const taskpanePath = path.join(root, 'src', 'taskpane', 'taskpane.html');
if (fs.existsSync(taskpanePath)) {
  let taskpane = fs.readFileSync(taskpanePath, 'utf8');
  taskpane = taskpane.replace(
    /(<span id="app-version">)[^<]+(<\/span>)/,
    `$1${semver}$2`,
  );
  fs.writeFileSync(taskpanePath, taskpane, 'utf8');
  console.log(`✓ taskpane.html version updated to ${semver}`);
}
