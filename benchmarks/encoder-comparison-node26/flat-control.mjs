import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('.', import.meta.url));
const main = JSON.parse(readFileSync(folder + 'summary.json', 'utf8'));
const candidates = ['tsv22', 'unescaped22', 'prepared22', 'json22', 'json26'];
const node22 = process.env.NODE22 || main.metadata.runtimes[0].path;
const node26 = process.env.NODE26 || main.metadata.runtimes[1].path;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const execute = (candidate, mode) => {
  const result = spawnSync(candidate.endsWith('26') ? node26 : node22, [folder + 'run.mjs', mode, candidate, folder + 'snapshot', 'string'], {
    env: { ...process.env, FLAT_INPUT: '1' }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
for (const candidate of ['json22', 'json26']) {
  const check = execute(candidate, '--check');
  const source = JSON.parse(readFileSync(folder + 'raw/correctness22.json', 'utf8'));
  assert.deepEqual(check.datasets, source.datasets);
  writeFileSync(folder + 'raw/flat-correctness-' + candidate + '.json', JSON.stringify(check, null, 2) + '\n');
}
const runs = [];
for (let repetition = 0; repetition < 3; repetition++) {
  for (const candidate of candidates.map((_, index) => candidates[(index + repetition) % candidates.length])) {
    console.log(`Flat ASCII ${repetition + 1}/3: ${candidate}`);
    const run = execute(candidate, '--worker');
    runs.push(run);
    writeFileSync(folder + `raw/flat-${repetition + 1}-${candidate}.json`, JSON.stringify(run, null, 2) + '\n');
  }
}
const results = Object.fromEntries(candidates.map((candidate) => {
  const values = runs.filter((run) => run.candidate === candidate).map((run) => run.results.ascii);
  const cpu = values.map((result) => result.cpuMsPerBatch);
  const wall = values.map((result) => result.wallMsPerBatch);
  return [candidate, { cpuMsPerBatch: median(cpu), cpuMin: Math.min(...cpu), cpuMax: Math.max(...cpu), wallMsPerBatch: median(wall), wallMin: Math.min(...wall), wallMax: Math.max(...wall) }];
}));
writeFileSync(folder + 'flat-summary.json', JSON.stringify({ metadata: { ...main.metadata, repetitions: 3, representation: 'JSON.parse(JSON.stringify(rows)) before preparation, warmup and measurement; all fields' }, results }, null, 2) + '\n');
console.log(results);
const heading = '\n## Дополнительный контроль: заранее материализованные ASCII-строки\n';
const header = '| Метрика, мс на батч | TSV / Node 22 | Unescaped + подготовка / Node 22 | Unescaped готовые строки / Node 22 | JSON / Node 22 | JSON / Node 26 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n';
const table = header + '| CPU | ' + candidates.map((candidate) => results[candidate].cpuMsPerBatch.toFixed(3)).join(' | ') + ' |\n' + '| Wall | ' + candidates.map((candidate) => results[candidate].wallMsPerBatch.toFixed(3)).join(' | ') + ' |\n' + '| Разброс CPU | ' + candidates.map((candidate) => results[candidate].cpuMin.toFixed(3) + '–' + results[candidate].cpuMax.toFixed(3)).join(' | ') + ' |\n';
const report = readFileSync(folder + 'RESULTS.md', 'utf8').split(heading)[0] + heading + '\nТот же большой ASCII-набор приведён через `JSON.parse(JSON.stringify(rows))` до подготовки TSV, прогрева и измерений. Это одинаковая предварительная обработка всех полей для всех пяти кандидатов. Её стоимость исключена. Текстовые значения и SHA-256 всех выходов совпали с исходным набором в обоих runtime; проверки сохранены в `raw/flat-correctness-*.json`.\n\n' + table + '\nТри последовательных процесса на кандидат с ротацией порядка, 200 мс прогрева и 7 раундов по 100 мс. Sink совпадает с основной таблицей: длина и последний символ строки. Сценарий отличается способом создания входных строк, а не набором ASCII-символов. Результат не означает, что добавление такой подготовки ускорит приложение: её цена не измерялась. Основная таблица сохранена отдельно.\n\nПовторение после основного benchmark: `node benchmarks/encoder-comparison-node26/flat-control.mjs`. Сводка — `flat-summary.json`, отдельные раунды — `raw/flat-*.json`.\n';
writeFileSync(folder + 'RESULTS.md', report);
