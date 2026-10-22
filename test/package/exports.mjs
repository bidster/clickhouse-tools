import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const esm = await import('@bidster/clickhouse-tools');
const esmNest = await import('@bidster/clickhouse-tools/nest');
const require = createRequire(import.meta.url);
const commonjs = require('@bidster/clickhouse-tools');
const commonjsNest = require('@bidster/clickhouse-tools/nest');

assert.equal('createClient' in esm, false);
assert.equal('createClient' in commonjs, false);
assert.equal(typeof esm.ClickHouseBatchWriter, 'function');
assert.equal(typeof commonjs.ClickHouseBatchWriter, 'function');
assert.equal(typeof esmNest.ClickHouseModule, 'function');
assert.equal(typeof commonjsNest.ClickHouseModule, 'function');
assert.equal(typeof esmNest.InjectClickHouse, 'function');
assert.equal(typeof commonjsNest.InjectClickHouse, 'function');
assert.equal(typeof esmNest.InjectClickHouseBatchWriter, 'function');
assert.equal(typeof commonjsNest.InjectClickHouseBatchWriter, 'function');
assert.equal(typeof esmNest.getClickHouseToken, 'function');
assert.equal(typeof commonjsNest.getClickHouseToken, 'function');
assert.equal(typeof esmNest.getClickHouseBatchWriterToken, 'function');
assert.equal(typeof commonjsNest.getClickHouseBatchWriterToken, 'function');

const client = { exec: async () => ({ stream: Readable.from([]) }) };

for (const [core, nest] of [
  [esm, esmNest],
  [commonjs, commonjsNest],
]) {
  assert.equal(typeof core.TsvRowEncoder, 'function');
  assert.equal('ClickHouseTsvRowEncoder' in core, false);
  assert.equal(new core.TsvRowEncoder(['id']).encode([{ id: '\t' }]), String.raw`\t`);
  assert.equal(typeof core.CommaSeparatedJsonCompactEachRowEncoder, 'function');
  assert.equal(typeof core.UnescapedTsvRowEncoder, 'function');
  assert.equal(core.escapeTsvString('\t'), String.raw`\t`);
  assert.equal(
    new core.CommaSeparatedJsonCompactEachRowEncoder(['id']).encode([{ id: 'one' }, { id: 'two' }]),
    '["one"],["two"]',
  );
  assert.equal(new core.UnescapedTsvRowEncoder(['id']).encode([{ id: '\t' }]), '\t');
  const writerName = 'package-test';
  const writerToken = nest.getClickHouseBatchWriterToken(writerName);
  const dynamicModule = nest.ClickHouseBatchWriterModule.register({
    name: writerName,
    insert: { table: 'package_test', columns: ['id'] },
  });
  const writerProvider = dynamicModule.providers.find(
    (provider) => provider.provide === writerToken,
  );
  const writer = writerProvider.useFactory(client);

  assert.ok(writer instanceof core.ClickHouseBatchWriter);
  writer.write([{ id: 'one' }]);
  await writer.close();
}
