import {
  ClickHouseBatchWriter,
  TsvRowEncoder,
  CommaSeparatedJsonCompactEachRowEncoder,
  UnescapedTsvRowEncoder,
  escapeTsvString,
  type ClickHouseRowEncoder,
  type ClickHouseTextInsertFormat,
} from '@bidster/clickhouse-tools';
import {
  ClickHouseBatchWriterModule,
  ClickHouseModule,
} from '@bidster/clickhouse-tools/nest';

void ClickHouseBatchWriter;
void ClickHouseBatchWriterModule;
void ClickHouseModule;

const jsonEncoder: ClickHouseRowEncoder<{ id: string }> =
  new CommaSeparatedJsonCompactEachRowEncoder(['id']);
const tsvEncoder: ClickHouseRowEncoder<{ id: string }> =
  new UnescapedTsvRowEncoder(['id']);
const defaultEncoder: ClickHouseRowEncoder<{ id: string }> =
  new TsvRowEncoder(['id']);
const format: ClickHouseTextInsertFormat = 'JSONCompactEachRow';
jsonEncoder.encode([{ id: 'one' }]);
tsvEncoder.encode([{ id: escapeTsvString('\t') }]);
defaultEncoder.encode([{ id: '\t' }]);
void format;
