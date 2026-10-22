"""Render the saved benchmark results; does not run any benchmarks.

Requires matplotlib. Run from any directory: python plot.py
"""
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib.ticker import PercentFormatter

HERE = Path(__file__).resolve().parent
DESTINATION = HERE.parents[1] / 'docs' / 'benchmarks'
main = json.loads((HERE / 'summary.json').read_text())
control = json.loads((HERE / 'flat-summary.json').read_text())
scenarios = [
    ('Short text\n16–64 characters', main['results']['small']),
    ('JSON string\n~256 characters', main['results']['json256']),
    ('Text with\nspecial characters', main['results']['escaped']),
    ('Unicode text', main['results']['unicode']),
    ('Large JSON string\n~3 KB, ASCII', main['results']['large']),
    ('Large plain ASCII text\n~3 KB', main['results']['ascii']),
    ('Same large ASCII values\nparsed from JSON beforehand¹', control['results']),
]
series = [
    ('unescaped22', 'UnescapedTsvRowEncoder + preparation · Node.js 22', '#2473A6'),
    ('prepared22', 'UnescapedTsvRowEncoder · prepared rows · Node.js 22', '#177B58'),
    ('json22', 'CommaSeparatedJsonCompactEachRowEncoder · Node.js 22', '#BE691B'),
    ('json26', 'CommaSeparatedJsonCompactEachRowEncoder · Node.js 26', '#7753AD'),
]
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 12, 'svg.fonttype': 'none'})
fig, ax = plt.subplots(figsize=(15, 13), facecolor='white')
fig.subplots_adjust(left=0.255, right=0.97, top=0.755, bottom=0.15)
fig.text(0.04, 0.965, 'ClickHouse encoder CPU cost', fontsize=23, weight='bold', color='#17232D')
fig.text(0.04, 0.938, '1,000 rows per batch · Apple M4 Max · Node.js 22.22.0 / 26.12.1', color='#52606B', fontsize=12)
fig.text(0.04, 0.907, 'Baseline (100%): TsvRowEncoder · Node.js 22', weight='bold', fontsize=12)
fig.legend(handles=[Patch(facecolor=color, label=label) for _, label, color in series],
           loc='upper left', bbox_to_anchor=(0.035, 0.892), frameon=False,
           fontsize=11.5, handlelength=1.3, labelspacing=0.55)
centres, names = [], []
for index, (label, row) in enumerate(scenarios):
    start = index * 5.3
    baseline = row['tsv22']['cpuMsPerBatch']
    centres.append(start + 1.5)
    names.append(f'{label}\nTSV baseline: {baseline:.3f} ms')
    if index % 2 == 0:
        ax.axhspan(start - 0.65, start + 3.7, color='#F3F5F7', zorder=0)
    for offset, (key, _, color) in enumerate(series):
        value = row[key]['cpuMsPerBatch']
        ratio = 100 * value / baseline
        ax.barh(start + offset, ratio, height=0.70, color=color, zorder=3)
        ax.text(ratio + 2, start + offset, f'{value:.3f} ms  ({ratio - 100:+.1f}%)',
                va='center', fontsize=11, color='#27333D', zorder=4)
ax.axvline(100, color='#52606B', linestyle=(0, (4, 4)), linewidth=1.2, zorder=2)
ax.set_xlim(0, 207)
ax.set_ylim(-0.8, (len(scenarios) - 1) * 5.3 + 3.9)
ax.invert_yaxis()
ax.set_yticks(centres, names)
ax.tick_params(axis='y', length=0, pad=16, labelsize=11.5)
ax.set_xticks([0, 50, 100, 150, 200])
ax.xaxis.set_major_formatter(PercentFormatter(xmax=100, decimals=0))
ax.tick_params(axis='x', length=0, pad=9, colors='#52606B')
ax.set_xlabel('CPU time relative to default TSV in the same scenario · shorter is better', labelpad=13, fontsize=11.5)
ax.grid(axis='x', color='#DDE2E6', linewidth=0.7, zorder=1)
for spine in ax.spines.values():
    spine.set_visible(False)
fig.text(0.04, 0.072, 'Labels: milliseconds per batch and change vs baseline. Prepared rows exclude escaping and row preparation.', fontsize=10.5, color='#52606B')
fig.text(0.04, 0.050, '¹ Same values loaded through JSON.parse before timing; that work is excluded for every encoder.', fontsize=10.5, color='#52606B')
fig.text(0.04, 0.028, 'Median of 5 runs (3 for the final control). Serialization only; no network or compression. Small differences may be noise.', fontsize=10.5, color='#52606B')
DESTINATION.mkdir(parents=True, exist_ok=True)
for extension in ('svg', 'png'):
    output = DESTINATION / f'encoder-comparison.{extension}'
    fig.savefig(output, dpi=160, facecolor='white', metadata={'Creator': 'Matplotlib'})
    print(output)
plt.close(fig)
