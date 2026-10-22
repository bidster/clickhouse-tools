import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const columns = ['id', 'createdAt', 'type', 'source', 'sequence', 'price', 'active', 'optional', 'data'];
const candidates = ['tsv22', 'unescaped22', 'prepared22', 'json22', 'json26'];
const node22 = process.env.NODE22 || '/Users/mayorovigor/.nvm/versions/node/v22.22.0/bin/node';
const node26 = process.env.NODE26 || '/tmp/codex-node26-benchmark/node-v26.12.1-darwin-arm64/bin/node';
const runtimeFor = (candidate) => candidate.endsWith('26') ? node26 : node22;
const candidateLabels = ['TSV / Node 22', 'Unescaped + подготовка / Node 22', 'Unescaped готовые строки / Node 22', 'JSON / Node 22', 'JSON / Node 26'];
const labels = {
  small: 'Короткие строки (16–64 символа)',
  json256: 'JSON-строка (~256 символов)',
  escaped: 'Текст со спецсимволами',
  unicode: 'Unicode-текст',
  large: 'Большая JSON-строка (~3 КБ, ASCII)',
  ascii: 'Большой текст (~3 КБ, ASCII без экранирования)',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const batchSize = 1000;
const repetitions = 5;
const rounds = 7;
const warmupMs = 200;
const roundMs = 100;
const datasets = Object.fromEntries(Object.keys(labels).map((name) => [name, Array.from({ length: batchSize }, (_, i) => {
  let data;
  if (name === 'small') data = ('event-' + i + '-').padEnd(16 + i % 49, 'x');
  if (name === 'json256') data = JSON.stringify({ campaign: `campaign-${i % 100}`, tag: 'page_view', url: `https://example.org/path/${i}`, note: 'x'.repeat(160) });
  if (name === 'escaped') data = (`row ${i}: "quoted"\\path\tvalue\nnext\rline; literal \\N; `).repeat(5);
  if (name === 'unicode') data = (`Событие ${i}: café, 東京, 🚀 — пользователь открыл страницу. `).repeat(4);
  if (name === 'large') data = JSON.stringify({ event: i, payload: 'x'.repeat(3000), source: 'mobile' });
  if (name === 'ascii') data = (`event-${i}-`).padEnd(JSON.stringify({ event: i, payload: 'x'.repeat(3000), source: 'mobile' }).length, 'x');
  // Only data can contain TSV-sensitive characters; the remaining strings are guaranteed safe.
  return { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, createdAt: '2026-10-22 12:34:56.789', type: 'page_view', source: 'mobile', sequence: i, price: (i % 100) / 10, active: i % 2 === 0, optional: i % 3 === 0 ? null : 'known', data };
})]));

if (process.env.FLAT_INPUT === '1') {
  for (const name of Object.keys(datasets)) datasets[name] = JSON.parse(JSON.stringify(datasets[name]));
}

async function loadEncoders(compiled) {
  const { escapeTsvString } = await import(pathToFileURL(path.join(compiled, 'escape-tsv-string.js')));
  const { TsvRowEncoder } = await import(pathToFileURL(path.join(compiled, 'tsv-row-encoder.js')));
  const { UnescapedTsvRowEncoder } = await import(pathToFileURL(path.join(compiled, 'unescaped-tsv-row-encoder.js')));
  const { CommaSeparatedJsonCompactEachRowEncoder } = await import(pathToFileURL(path.join(compiled, 'comma-separated-json-compact-each-row-encoder.js')));
  const tsv = new TsvRowEncoder(columns);
  const unescaped = new UnescapedTsvRowEncoder(columns);
  const json = new CommaSeparatedJsonCompactEachRowEncoder(columns);
  return {
    prepare: (rows) => rows.map((row) => ({ ...row, data: escapeTsvString(row.data) })),
    prepared22: (rows) => unescaped.encode(rows),
    tsv22: (rows) => tsv.encode(rows),
    // The complete preparation cost is measured on every batch, including allocation of rows.
    unescaped22: (rows) => unescaped.encode(rows.map((row) => ({ ...row, data: escapeTsvString(row.data) }))),
    json22: (rows) => json.encode(rows),
    json26: (rows) => json.encode(rows),
  };
}

if (process.argv[2] === '--worker' || process.argv[2] === '--check') {
  const candidate = process.argv[3];
  const encoders = await loadEncoders(process.argv[4]);
  const prepared = candidate === 'prepared22' || process.argv[2] === '--check'
    ? Object.fromEntries(Object.entries(datasets).map(([name, rows]) => [name, encoders.prepare(rows)]))
    : null;
  const runtime = { node: process.version, v8: process.versions.v8, path: process.execPath };
  if (process.argv[2] === '--check') {
    const correctness = {};
    for (const [name, rows] of Object.entries(datasets)) {
      const bodies = Object.fromEntries(candidates.map((key) => [key, encoders[key](key === 'prepared22' ? prepared[name] : rows)]));
      assert.equal(bodies.tsv22, bodies.unescaped22);
      assert.equal(bodies.tsv22, bodies.prepared22);
      assert.equal(bodies.json22, bodies.json26);
      assert.deepEqual(JSON.parse(`[${bodies.json22}]`), rows.map((row) => columns.map((column) => row[column])));
      const allInputStringsAscii = rows.every((row) => Object.values(row).every((value) => typeof value !== 'string' || /^[\x00-\x7f]*$/.test(value)));
      if (name === 'ascii' || name === 'large') assert.equal(allInputStringsAscii, true);
      if (name === 'ascii') {
        assert(rows.every((row) => !row.data.includes('"') && !row.data.includes('\\') && !/[\x00-\x1f]/.test(row.data)));
        assert(rows.every((row, index) => row.data.length === datasets.large[index].data.length));
      }
      correctness[name] = {
        allInputStringsAscii,
        inputDataLength: { min: Math.min(...rows.map((row) => row.data.length)), max: Math.max(...rows.map((row) => row.data.length)) },
        outputs: Object.fromEntries(candidates.map((key) => [key, { bytes: Buffer.byteLength(bodies[key]), chars: bodies[key].length, sha256: hash(bodies[key]) }])),
      };
    }
    for (const data of ['', '\\N', '\\t\\n\\r', '\t\n\r\\', '"quotes"', 'Я🚀\n\\N']) {
      const rows = [{ ...datasets.small[0], data }];
      assert.equal(encoders.tsv22(rows), encoders.unescaped22(rows));
      assert.equal(encoders.tsv22(rows), encoders.prepared22(encoders.prepare(rows)));
      assert.deepEqual(JSON.parse(`[${encoders.json22(rows)}]`), rows.map((row) => columns.map((column) => row[column])));
    }
    process.stdout.write(JSON.stringify({ runtime, passed: true, scenarioCount: 6, extraEdgeCases: 6, datasets: correctness }));
  } else {
    const encode = encoders[candidate];
    const consumption = process.argv[5] || 'string';
    let sink = 0;
    const results = {};
    for (const [name, sourceRows] of Object.entries(datasets)) {
      if ((consumption === 'buffer' || process.env.FLAT_INPUT === '1') && name !== 'ascii') continue;
      const rows = candidate === 'prepared22' ? prepared[name] : sourceRows;
      const run = (duration) => {
        const start = performance.now();
        const cpuStart = process.cpuUsage();
        let iterations = 0;
        do {
          const body = encode(rows);
          if (consumption === 'buffer') {
            const bytes = Buffer.from(body);
            sink = (sink + bytes.length + bytes[bytes.length - 1]) | 0;
          } else {
            sink = (sink + body.length + body.charCodeAt(body.length - 1)) | 0;
          }
          iterations++;
        } while (performance.now() - start < duration);
        const cpu = process.cpuUsage(cpuStart);
        const elapsed = performance.now() - start;
        return { iterations, wallMsPerBatch: elapsed / iterations, cpuMsPerBatch: (cpu.user + cpu.system) / 1000 / iterations };
      };
      run(warmupMs);
      const samples = Array.from({ length: rounds }, () => run(roundMs));
      results[name] = { cpuMsPerBatch: median(samples.map((sample) => sample.cpuMsPerBatch)), wallMsPerBatch: median(samples.map((sample) => sample.wallMsPerBatch)), samples };
    }
    process.stdout.write(JSON.stringify({ candidate, consumption, flatInput: process.env.FLAT_INPUT === '1', results, sink, runtime }));
  }
} else {
  mkdirSync(path.join(directory, 'raw'), { recursive: true });
  const compiled = path.join(directory, 'snapshot');
  mkdirSync(compiled, { recursive: true });
  const sourceHashes = {};
  writeFileSync(path.join(compiled, 'package.json'), '{"type":"module"}\n');
  for (const file of ['escape-tsv-string.ts', 'tsv-row-encoder.ts', 'unescaped-tsv-row-encoder.ts', 'comma-separated-json-compact-each-row-encoder.ts']) {
    const source = readFileSync(path.join(root, 'src/encoders', file), 'utf8');
    sourceHashes[file] = hash(source);
    writeFileSync(path.join(compiled, file), source);
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    writeFileSync(path.join(compiled, file.replace(/\.ts$/, '.js')), output);
  }
  const execute = (candidate, mode, consumption = 'string') => {
    const result = spawnSync(runtimeFor(candidate), [fileURLToPath(import.meta.url), mode, candidate, compiled, consumption], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Worker exited ${result.status}`);
    return JSON.parse(result.stdout);
  };
  const correctness22 = execute('json22', '--check');
  const correctness26 = execute('json26', '--check');
  assert.deepEqual(correctness22.datasets, correctness26.datasets);
  writeFileSync(path.join(directory, 'raw/correctness22.json'), JSON.stringify(correctness22, null, 2) + '\n');
  writeFileSync(path.join(directory, 'raw/correctness26.json'), JSON.stringify(correctness26, null, 2) + '\n');
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const order = candidates.map((_, index) => candidates[(index + repetition) % candidates.length]);
    for (const candidate of order) {
      process.stdout.write(`Повтор ${repetition + 1}/${repetitions}: ${candidate}\n`);
      const run = execute(candidate, '--worker');
      runs.push(run);
      writeFileSync(path.join(directory, `raw/${repetition + 1}-${candidate}.json`), JSON.stringify(run, null, 2) + '\n');
    }
  }
  const controls = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const candidate of candidates.map((_, index) => candidates[(index + repetition) % candidates.length])) {
      process.stdout.write(`Контроль Buffer ${repetition + 1}/3: ${candidate}\n`);
      const run = execute(candidate, '--worker', 'buffer');
      controls.push(run);
      writeFileSync(path.join(directory, `raw/buffer-${repetition + 1}-${candidate}.json`), JSON.stringify(run, null, 2) + '\n');
    }
  }
  const summarize = (measurements) => {
    const cpu = measurements.map((result) => result.cpuMsPerBatch);
    const wall = measurements.map((result) => result.wallMsPerBatch);
    return { cpuMsPerBatch: median(cpu), cpuMin: Math.min(...cpu), cpuMax: Math.max(...cpu), wallMsPerBatch: median(wall), wallMin: Math.min(...wall), wallMax: Math.max(...wall) };
  };
  const results = Object.fromEntries(Object.keys(datasets).map((name) => [name, Object.fromEntries(candidates.map((candidate) => [candidate, summarize(runs.filter((run) => run.candidate === candidate).map((run) => run.results[name]))]))]));
  const bufferControl = Object.fromEntries(candidates.map((candidate) => [candidate, summarize(controls.filter((run) => run.candidate === candidate).map((run) => run.results.ascii))]));
  const metadata = { date: new Date().toISOString(), runtimes: [correctness22.runtime, correctness26.runtime], platform: process.platform, release: os.release(), architecture: process.arch, cpu: os.cpus()[0].model, cpuCount: os.cpus().length, batchSize, repetitions, rounds, warmupMs, roundMs, sourceHashes };
  writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ metadata, results, bufferControl }, null, 2) + '\n');
  const header = `| Данные | ${candidateLabels.join(' | ')} |\n| --- | ---: | ---: | ---: | ---: | ---: |\n`;
  const table = (metric) => header + Object.keys(datasets).map((name) => `| ${labels[name]} | ${candidates.map((candidate) => results[name][candidate][metric].toFixed(3)).join(' | ')} |`).join('\n');
  const ranges = header + Object.keys(datasets).map((name) => `| ${labels[name]} | ${candidates.map((candidate) => `${results[name][candidate].cpuMin.toFixed(3)}–${results[name][candidate].cpuMax.toFixed(3)}`).join(' | ')} |`).join('\n');
  const report = `# Сравнение энкодеров: готовый TSV и Node.js 26\n\nИзмерено 22 октября 2026 на ${metadata.cpu}, ${metadata.platform}/${metadata.architecture}. Node.js ${correctness22.runtime.node}, V8 ${correctness22.runtime.v8}; Node.js ${correctness26.runtime.node}, V8 ${correctness26.runtime.v8}. Пути runtime сохранены в summary.json.\n\n## CPU, мс на батч из 1000 строк\n\n${table('cpuMsPerBatch')}\n\nМеньше — лучше. Медиана медиан ${repetitions} отдельных процессов на вариант, ${rounds} раундов на набор. Все результаты получены заново в одном запуске.\n\n## Wall time, мс на батч из 1000 строк\n\n${table('wallMsPerBatch')}\n\n## Разброс CPU между процессами\n\nМинимум–максимум медиан процессов, мс на батч:\n\n${ranges}\n\nПересечение диапазонов не доказывает преимущество малой разницы медиан. Это наблюдаемый разброс, а не доверительный интервал.\n\n## Контроль потребления результата\n\nОтдельный контроль для большого чистого ASCII, с Buffer.from(body) внутри измерения; три процесса на вариант, тот же прогрев и семь раундов. Эти значения не смешиваются с основной таблицей:\n\n${header}| Большой чистый ASCII + Buffer.from | ${candidates.map((candidate) => bufferControl[candidate].cpuMsPerBatch.toFixed(3)).join(' | ')} |\n\nВ основной таблице результат потребляется через string.length и charCodeAt последнего символа. Контроль дополнительно материализует UTF-8-буфер целиком; он включает другую работу и не измеряет отправку по сети. Его сырые данные и диапазоны сохранены отдельно.\n\n## Методика\n\n- Использованы актуальные классы из src/encoders, транспилированные TypeScript в ESM с target ES2022. Копии исходников и модулей сохранены в snapshot/, SHA-256 — в summary.json. Production-код не менялся.\n- Каждый набор содержит 1000 объектов по 9 полей (UUID, дата, тип, источник, целое и дробное число, boolean, nullable-строка, data). JSON внутри data остаётся строкой.\n- Unescaped + подготовка включает rows.map(row => ({ ...row, data: escapeTsvString(row.data) })) на каждом батче; стоимость экранирования и создания объектов входит в измерение.\n- Unescaped готовые строки получает те же подготовленные строки, созданные один раз до прогрева и измерений. Эта колонка показывает стоимость самого энкодера и исключает стоимость подготовки. Другие строковые поля безопасны для TSV во всех наборах.\n- Генерация исходных объектов и строк не входит ни в одну колонку. Данные не приводились дополнительно к плоскому внутреннему представлению V8. Различия runtime могут зависеть от внутреннего представления строк и пути JSON.stringify, а не только от символов.\n- Большая JSON-строка уже целиком ASCII, но содержит кавычки, требующие JSON-экранирования. Дополнительный большой ASCII-текст не содержит кавычек, обратных слешей и управляющих символов; его длина совпадает с большой JSON-строкой для каждой строки (3042–3044 символа). ASCII проверен у всех строковых полей обоих больших наборов.\n- Каждый отдельный процесс измеряет один энкодер/runtime; процессы запускаются строго последовательно, порядок пяти кандидатов ротируется. Прогрев ${warmupMs} мс, ${rounds} раундов минимум по ${roundMs} мс на набор. CPU — process.cpuUsage() user+system, wall — performance.now().\n- Основная таблица исключает Buffer, подсчёт UTF-8-размера, хеширование, сеть, сжатие, writer и ClickHouse. Размеры выходного TSV и JSON различаются естественным образом.\n- В отдельных процессах Node 22 и Node 26 до измерений проверено точное равенство трёх TSV-путей, JSON roundtrip, совпадение SHA-256 всех выходов между runtime на шести наборах и шесть дополнительных пограничных значений. Проверки прошли. Длины, UTF-8-байты, SHA-256 — в raw/correctness22.json и raw/correctness26.json.\n- Это сравнительная стоимость сериализации конкретных данных на данной машине, без утверждения, что ASCII или определённый runtime всегда быстрее. Для перехода между runtime здесь измерен только JSON-энкодер; из таблицы нельзя вывести производительность TSV на Node 26.\n\n## Повторение\n\nИз корня после установки зависимостей:\n\n\`\`\`sh\nNODE22=/path/to/node22 NODE26=/path/to/node26 node benchmarks/encoder-comparison-node26/run.mjs\n\`\`\`\n\nПо умолчанию скрипт использует локальные пути исходного запуска. Node 26 взят из ранее проверенного архива; provenance сохранён в node26-provenance.json. Новый запуск обновляет snapshot/ текущими src, raw/ и отчёт.\n`;
  writeFileSync(path.join(directory, 'RESULTS.md'), report);
  process.stdout.write(table('cpuMsPerBatch') + '\n');
}
