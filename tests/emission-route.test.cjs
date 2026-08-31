const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readEmissionChunks = () =>
    fs.readdirSync(path.join(root, "emission", "_next", "static", "chunks"))
        .filter((name) => name.endsWith(".js"))
        .map((name) => read(path.join("emission", "_next", "static", "chunks", name)))
        .join("\n");
const listFiles = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(absolute) : [absolute];
    });

test("exposes Emission as a dedicated same-origin explorer tab", function () {
    const index = read("index.html");
    const app = read("js/app.js");

    assert.match(index, /v-if="item\.href"[\s\S]*?:href="item\.href"/);
    assert.match(app, /name: "emission", label: "Emission", icon: "fa-coins", href: "\/emission\/"/);
    assert.doesNotMatch(index + app, /matthewfreeman\.github\.io/i);
});

test("ships a self-contained official-domain emission export", function () {
    const html = read("emission/index.html");
    const assetPaths = Array.from(
        html.matchAll(/(?:src|href)="(\/emission\/[^"#?]+)"/g),
        (match) => match[1],
    );

    assert.match(html, /<link rel="canonical" href="https:\/\/explorer\.discrete\.cash\/emission\/"/);
    assert.match(html, /href="https:\/\/explorer\.discrete\.cash\/" aria-label="Back to Discrete Explorer"/);
    const desktopNavigation = html.match(/<nav class="nav-links"[\s\S]*?<\/nav>/i)?.[0] ?? "";
    assert.match(desktopNavigation, /href="#explorer">Emission<\/a>/i);
    assert.doesNotMatch(desktopNavigation, /href="#explorer">Explorer<\/a>/i);
    assert.doesNotMatch(html, /matthewfreeman\.github\.io/i);
    assert.ok(assetPaths.length > 10, "expected the static export to reference its bundled assets");

    for (const assetPath of new Set(assetPaths)) {
        const relativePath = assetPath.slice("/emission/".length);
        assert.equal(fs.existsSync(path.join(root, "emission", relativePath)), true, `missing ${assetPath}`);
    }

    assert.equal(fs.existsSync(path.join(root, ".nojekyll")), true);
});

test("anchors Today to the live Discrete chain tip", function () {
    const html = read("emission/index.html");
    const chunks = readEmissionChunks();

    assert.match(chunks, /Actual chain tip/);
    assert.match(html, />Today</);
    assert.match(chunks, /https:\/\/seed1\.discrete\.cash:9332/);
    assert.match(chunks, /https:\/\/seed2\.discrete\.cash:9332/);
    assert.match(chunks, /getblockheaderbyheight/);
    assert.match(chunks, /already_generated_coins/);
    assert.match(chunks, /next_reward/);
    assert.match(chunks, /Discrete RPC quorum is unavailable/);
    assert.match(chunks, /Discrete RPC nodes disagree on the chain tip/);
    assert.match(chunks, /Live RPC snapshot expired/);
    assert.match(chunks, /let \w+=\w+-1,\w+=await [\s\S]{0,300}?getblockheaderbyheight/);
});

test("ships desktop and mobile selected-value callouts", function () {
    const html = read("emission/index.html");

    assert.equal((html.match(/class="selected-overlay-label unlocked"/g) || []).length, 2);
    assert.equal((html.match(/class="selected-treasury-label"/g) || []).length, 2);
    assert.match(html, /Circulating supply/);
});

test("binds every emission artifact to the reviewed source commit", function () {
    const emissionRoot = path.join(root, "emission");
    const manifestPath = path.join(emissionRoot, "EXPORT-MANIFEST.sha256");
    const manifestRows = fs.readFileSync(manifestPath, "utf8").trimEnd().split(/\r?\n/);
    const manifest = new Map(manifestRows.map((row) => {
        const match = row.match(/^([0-9a-f]{64})  (.+)$/);
        assert.ok(match, `invalid manifest row: ${row}`);
        return [match[2], match[1]];
    }));
    const files = listFiles(emissionRoot)
        .filter((file) => file !== manifestPath)
        .map((file) => path.relative(emissionRoot, file).split(path.sep).join("/"))
        .sort();

    assert.deepEqual(Array.from(manifest.keys()), files);
    for (const relativePath of files) {
        const digest = crypto.createHash("sha256")
            .update(fs.readFileSync(path.join(emissionRoot, relativePath)))
            .digest("hex");
        assert.equal(manifest.get(relativePath), digest, `digest mismatch: ${relativePath}`);
    }

    const sourceCommit = "f26d090fa7418a6395bc18d9caafc51d03edfadc";
    const source = read("emission/SOURCE.md");
    assert.match(source, new RegExp(`MatthewFreeman/discrete-explorer/tree/${sourceCommit}`));
    assert.equal(
        fs.existsSync(path.join(emissionRoot, "_next", "static", sourceCommit)),
        true,
        "Next build ID must equal the immutable source commit",
    );
});

test("preserves the reviewed 120-month CSV artifact", function () {
    const csv = fs.readFileSync(path.join(root, "emission", "data", "emission-decade.csv"));
    const digest = crypto.createHash("sha256").update(csv).digest("hex").toUpperCase();
    const rows = csv.toString("utf8").trimEnd().split(/\r?\n/);

    assert.equal(rows.length, 121);
    assert.equal(digest, "F9EF57271022D67C65F2224F2173EF9C8F3DF34B9D8B5D3375C3238729EB8A85");
});
