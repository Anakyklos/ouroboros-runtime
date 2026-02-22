const pattern = '*.ts';
const replacement1 = pattern.replace(/\./g, '\.');
const replacement2 = pattern.replace(/\./g, '\\.');
const replacement3 = pattern.replace(/\./g, '\\\.');

console.log('1:', replacement1);
console.log('2:', replacement2);
console.log('3:', replacement3);

const r1 = new RegExp('^' + replacement1.replace(/\*/g, '.*') + '$');
const r2 = new RegExp('^' + replacement2.replace(/\*/g, '.*') + '$');

console.log('R1 source:', r1.source);
console.log('R2 source:', r2.source);

console.log('R1 matches .ts:', r1.test('.ts'));
console.log('R1 matches ats:', r1.test('ats'));

console.log('R2 matches .ts:', r2.test('.ts'));
console.log('R2 matches ats:', r2.test('ats'));
