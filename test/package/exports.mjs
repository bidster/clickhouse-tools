import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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

const client = { insert: async () => ({ executed: true, query_id: 'test' }) };

for (const [core, nest] of [
  [esm, esmNest],
  [commonjs, commonjsNest],
]) {
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
  await writer.close();
}
