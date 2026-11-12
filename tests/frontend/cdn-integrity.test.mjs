// Every library index.html loads from a CDN must carry a Subresource Integrity hash that
// matches the published npm package, so the browser refuses a tampered or changed file.
//
// The same libraries are devDependencies in package.json at the same versions, and the
// hash is computed from node_modules, so this needs no network. To upgrade a library:
// bump it in package.json, run npm install, update the version in the index.html URL, and
// paste the hash this test prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');

const html = read('public/index.html');
const pkg = JSON.parse(read('package.json'));
const swHosts = JSON.parse(read('public/sw.js').match(/const CDN_HOSTS = (\[.*?\]);/)[1].replace(/'/g, '"'));

// <script ... src="https://..."> and <link rel="stylesheet" ... href="https://...">
const tags = [...html.matchAll(/<(script|link)\b[^>]*>/g)]
    .map(([tag]) => ({ tag, url: tag.match(/\b(?:src|href)="(https:\/\/[^"]+)"/)?.[1] }))
    .filter(({ tag, url }) => url && (tag.startsWith('<script') || /rel="stylesheet"/.test(tag)));

// https://cdn.jsdelivr.net/npm/<name>@<version>/<file> or https://unpkg.com/<name>@<version>/<file>
function parseCdnUrl(url) {
    const { hostname, pathname } = new URL(url);
    const m = pathname.replace(/^\/npm\//, '/').match(/^\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/);
    assert.ok(m, `can't read a package name and version from ${url}`);
    return { hostname, name: m[1], version: m[2], file: m[3] };
}

test('index.html loads some CDN files', () => {
    assert.ok(tags.length >= 4, `found ${tags.length}`);
});

for (const { tag, url } of tags) {
    test(`integrity hash for ${url}`, () => {
        const { hostname, name, version, file } = parseCdnUrl(url);

        assert.ok(swHosts.includes(hostname), `${hostname} is missing from CDN_HOSTS in public/sw.js`);
        assert.match(tag, /\bcrossorigin="anonymous"/, 'needs crossorigin="anonymous" for the integrity check');
        assert.equal(pkg.devDependencies[name], version,
            `package.json devDependencies should pin ${name} to ${version} (the version index.html loads)`);

        const installed = JSON.parse(read(`node_modules/${name}/package.json`)).version;
        assert.equal(installed, version, `node_modules has ${name}@${installed}; run npm ci`);

        const expected = 'sha384-' + createHash('sha384').update(readFileSync(`${root}node_modules/${name}/${file}`)).digest('base64');
        const actual = tag.match(/\bintegrity="([^"]+)"/)?.[1];
        assert.equal(actual, expected, `set integrity="${expected}" on ${url}`);
    });
}
