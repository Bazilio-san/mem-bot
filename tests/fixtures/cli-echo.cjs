// Фикстура CLI-движка анализа: читает промпт со stdin и печатает маркер с его длиной.
let s = '';
process.stdin.on('data', (d) => {
  s += d;
});
process.stdin.on('end', () => {
  console.log(`ANALYSIS-OK:${s.length}`);
});
