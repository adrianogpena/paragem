// Tests the pure logic block (<script id="core">) inside index.html against sample /realtime responses.
// Run: node test/core.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const src = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const ctx = { module: { exports: {} } };
vm.runInNewContext(src, ctx);
const Core = ctx.module.exports;
// objects from the vm realm have other prototypes; compare as plain data
const plain = x => JSON.parse(JSON.stringify(x));
const eq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };

// ---- the 502 example line (toward Matosinhos), as in the brief ----
const BRIEF = 'BLRB2 Bolhão, BLFZ1 Bolhão (Firmeza), JN3 Jornal de Notícias, PRR1 Pr. da República, FIG Figueiroa, CVA1 Carvalhosa, HML1 Hospital Militar, BVBR2 Boavista Brasília, BCM1 Boavista-Casa da Música, AGM1 Agramonte, ACRD1 António Cardoso, BSS1 Bessa, FOCO1 Foco, PINM1 Pinheiro Manso, SRV3 Serralves, PNV2 Paulo Novais, FTM4 Fonte da Moura, LGO2 Liceu Garcia Orta, PRCD3 Parque da Cidade, NEV2 Nevogilde, MAL2 Malaca, CQ5 Sea Life Castelo do Queijo, PCID1 Pr. Cid. Salvador, SAR1 Sousa Aroso, AVM1 Av. Menéres, MTSP1 Matosinhos Praia, GODH5 Godinho, LOTA1 Lota, SP1 S. Pedro, MATM6 Matosinhos Mercado.';
const stops = Core.parseStopList(BRIEF);
const idx = code => stops.findIndex(s => s.code === code);
const MY = idx('BCM1');

// ---- sample /realtime responses, in the documented shape ----
const A = '502_0_1|311|D1|T9|N7';    // on the road, between Carvalhosa and Hospital Militar
const B = '502_0_1|311|D1|T10|N7';   // waiting at Bolhão (first stop)
const C = '502_0_1|311|D1|T11|N7';   // only a timetable entry near my stop: not started
const PASSED = '502_0_1|311|D1|T8|N7'; // just left BCM1

const arr = (route, trip, min, extra = {}) => ({
  route_short_name: route, trip_headsign: route === '502' ? 'Matosinhos (Mercado)' : 'Other', trip_id: trip,
  arrival_minutes: min, estimated_arrival_time: `21:${String(10 + min).padStart(2, '0')}:00`,
  delay_minutes: extra.delay ?? 0, status: extra.status ?? 'on_time', vehicle_id: null,
});
const rt = {
  BLRB2: [arr('502', B, 9), arr('200', '200_0_1|99|D1|T3|N2', 4)],
  BLFZ1: [arr('502', B, 10)],
  JN3:   [arr('502', B, 12), arr('201', '201_1_1|7|D1|T1|N1', 2)],
  PRR1:  [arr('502', B, 14)],
  FIG:   [arr('502', B, 16)],
  CVA1:  [arr('502', B, 18)],                                       // A has passed Carvalhosa: not listed
  HML1:  [arr('502', A, 1, { delay: 3, status: 'delayed' }), arr('502', B, 20)],
  BVBR2: [arr('502', A, 3, { delay: 3, status: 'delayed' }), arr('502', B, 22), arr('502', C, 46)],
  BCM1:  [arr('502', A, 5, { delay: 3, status: 'delayed' }), arr('502', PASSED, -1), arr('502', B, 25),
          arr('502', B, 26), /* duplicate row for B, larger: ignored */ arr('502', C, 48), arr('200', '200_0_1|99|D1|T3|N2', 2)],
  AGM1:  [arr('502', PASSED, 1), arr('502', A, 7), arr('502', B, 27)],
  ACRD1: [arr('502', PASSED, 3), arr('502', A, 9)],
};
const response = code => ({ stop_id: code, stop_name: stops[idx(code)]?.name, arrivals: rt[code] || [], last_updated: '2026-10-08T21:10:00', data_source: 'realtime' });

function mockFetch() {
  const calls = [];
  const fn = async id => { calls.push(id); return response(id); };
  fn.calls = calls;
  return fn;
}

console.log('Paragem core tests');

await test('paste parser reads the brief\'s comma-separated 502 list', () => {
  assert.equal(stops.length, 30);
  eq(stops[0], { id: 'BLRB2', code: 'BLRB2', name: 'Bolhão' });
  assert.equal(stops[1].name, 'Bolhão (Firmeza)');
  assert.equal(stops[4].code, 'FIG');
  assert.equal(stops[29].code, 'MATM6');
  assert.equal(stops[29].name, 'Matosinhos Mercado');
  assert.equal(MY, 8);
});

await test('paste parser accepts other layouts', () => {
  const s = Core.parseStopList('1. Bolhão (BLRB2)\nJornal de Notícias\tJN3\nFIG - Figueiroa\nnot a stop line');
  eq(s.map(x => x.code), ['BLRB2', 'JN3', 'FIG']);
  eq(s.map(x => x.name), ['Bolhão', 'Jornal de Notícias', 'Figueiroa']);
});

await test('trip_id grouping at one stop: keeps only line 502, drops negative minutes, dedupes by trip', () => {
  const g = Core.lineArrivals(rt.BCM1, '502');
  eq([...g.keys()].sort(), [A, B, C].sort());
  assert.equal(g.get(B)._m, 25, 'duplicate row keeps the smaller minutes');
  assert.ok(!g.has(PASSED), 'a bus with -1 min has already passed');
});

await test('locates the next 3 buses for BCM1', async () => {
  const f = mockFetch();
  const r = await Core.track({ fetchStop: f, stops, myIdx: MY, line: '502', count: 3, maxBack: 30 });
  const buses = Core.locate({ obs: r.obs, stops, myIdx: MY, count: 3 });
  const [a, b, c] = buses;

  assert.equal(a.tripId, A);
  assert.equal(a.minutes, 5);
  assert.equal(a.nextName, 'Hospital Militar');
  assert.equal(a.stopsAway, 2);
  assert.equal(a.state, 'moving');
  assert.equal(a.delay, 3);
  eq(a.etas, { 6: 1, 7: 3, 8: 5 });

  assert.equal(b.tripId, B);
  assert.equal(b.state, 'terminus');
  assert.equal(b.nextIdx, 0);
  assert.equal(b.stopsAway, 8);

  assert.equal(c.tripId, C);
  assert.equal(c.state, 'scheduled', 'a trip first seen 46 min out at the stop before mine has not started');

  // B is listed all the way back, so every stop to the start gets polled — and nothing past my stop.
  assert.equal(r.requests, 9);
  assert.ok(f.calls.every(id => idx(id) <= MY));
});

await test('following only the next bus stops polling as soon as it is placed', async () => {
  const f = mockFetch();
  const r = await Core.track({ fetchStop: f, stops, myIdx: MY, line: '502', count: 1, maxBack: 30, concurrency: 3 });
  // BCM1, then one batch BVBR2, HML1, CVA1 — A drops out at CVA1, done.
  eq(f.calls, ['BCM1', 'BVBR2', 'HML1', 'CVA1']);
  const [a] = Core.locate({ obs: r.obs, stops, myIdx: MY, count: 1 });
  assert.equal(a.stopsAway, 2);
});

await test('maxBack caps polling and marks distant buses as "far"', async () => {
  const f = mockFetch();
  const r = await Core.track({ fetchStop: f, stops, myIdx: MY, line: '502', count: 2, maxBack: 4 });
  assert.equal(r.requests, 5);
  const [, b] = Core.locate({ obs: r.obs, stops, myIdx: MY, count: 2 });
  assert.equal(b.state, 'far');
  assert.equal(b.stopsAway, 4);
});

await test('a failing stop mid-walk is reported, not fatal', async () => {
  const f = async id => { if (id === 'JN3') throw new Error('HTTP 500'); return response(id); };
  const r = await Core.track({ fetchStop: f, stops, myIdx: MY, line: '502', count: 2, maxBack: 30 });
  assert.equal(r.errors.length, 1);
  assert.equal(stops[r.errors[0].idx].code, 'JN3');
  const [a, b] = Core.locate({ obs: r.obs, stops, myIdx: MY, count: 2 });
  assert.equal(a.stopsAway, 2);
  assert.equal(b.state, 'far');
});

await test('route lookup and stop-list normalising', () => {
  const r = Core.findRoute({ dropdown_routes: [{ route_id: 77, route_short_name: '500', route_color: 'aa3333' }, { route_id: 81, route_short_name: '502', route_color: 'F5D24C' }] }, '502');
  eq(r, { routeId: '81', color: '#F5D24C', name: '' });
  const s = Core.normaliseRouteStops({ stops: [{ stop_id: 'AGM1', stop_code: 'AGM1', stop_name: 'Agramonte', stop_sequence: 2, stop_lat: 41.1, stop_lon: -8.6 }, { stop_id: 'BCM1', stop_code: 'BCM1', stop_name: 'Casa da Música', stop_sequence: 1 }] });
  eq(s.map(x => x.id), ['BCM1', 'AGM1']);
});

await test('the last bus that passed is found one stop after mine', async () => {
  const base = await Core.track({ fetchStop: mockFetch(), stops, myIdx: MY, line: '502', count: 1 });
  const f = mockFetch();
  const r = await Core.track({ fetchStop: f, stops, myIdx: MY, line: '502', count: 1, ahead: 6 });
  eq(f.calls.slice(base.requests), ['AGM1', 'ACRD1', 'BSS1']);
  eq(r.requests, base.requests + 3);
  const p = Core.locatePassed({ obs: r.obs, stops, myIdx: MY });
  eq([p.tripId, p.nextIdx, p.stopsPast, p.nextMinutes], [PASSED, idx('AGM1'), 1, 1]);
  eq(Core.locate({ obs: r.obs, stops, myIdx: MY, count: 1 })[0].tripId, A);
});

await test('no bus passed: the forward walk stops after `ahead` stops', async () => {
  const calls = [];
  const fetchStop = async id => { calls.push(id); return id === 'BCM1' ? response('BCM1') : { arrivals: [arr('502', C, 40)] }; };
  const r = await Core.track({ fetchStop, stops, myIdx: MY, line: '502', count: 1, ahead: 6 });
  eq(calls.slice(-6), stops.slice(MY + 1, MY + 7).map(s => s.id));
  eq(r.requests, 1 + 3 + 6);
  eq(Core.locatePassed({ obs: r.obs, stops, myIdx: MY }), null);
});

await test('a busy stop whose list ends before the bus is skipped, not taken as "passed"', async () => {
  const busy = n => Array.from({ length: n }, (_, i) => arr('200', `200_0_1|99|D1|T${i}|N2`, 1 + (i % 2)));
  const lists = { BCM1: [arr('502', A, 5)], BVBR2: [arr('502', A, 3)], HML1: busy(8), CVA1: [arr('502', A, 1)], FIG: [] };
  const fetchStop = async id => ({ arrivals: lists[id] || [] });
  const r = await Core.track({ fetchStop, stops, myIdx: MY, line: '502', count: 1, maxBack: 30, concurrency: 1 });
  const [a] = Core.locate({ obs: r.obs, stops, myIdx: MY, count: 1 });
  eq([a.nextIdx, a.stopsAway, a.etas], [idx('CVA1'), 3, { [idx('CVA1')]: 1, [idx('BVBR2')]: 3, [MY]: 5 }]);
  lists.HML1 = busy(7);
  const r2 = await Core.track({ fetchStop, stops, myIdx: MY, line: '502', count: 1, maxBack: 30, concurrency: 1 });
  eq(Core.locate({ obs: r2.obs, stops, myIdx: MY, count: 1 })[0].nextIdx, idx('BVBR2'));
});

await test('a bus missing from my cut-off list only counts as passed if it is due before the list ends', async () => {
  const mine = [arr('502', A, 1), ...Array.from({ length: 7 }, (_, i) => arr('200', `200_0_1|99|D1|T${i}|N2`, 3))];
  const lists = { BCM1: mine, AGM1: [arr('502', C, 5)], ACRD1: [arr('502', PASSED, 2), arr('502', C, 7)] };
  const fetchStop = async id => ({ arrivals: lists[id] || [] });
  const r = await Core.track({ fetchStop, stops, myIdx: MY, line: '502', count: 1, maxBack: 0, ahead: 6, concurrency: 1 });
  const p = Core.locatePassed({ obs: r.obs, stops, myIdx: MY });
  eq([p.tripId, p.nextIdx], [PASSED, idx('ACRD1')]);
});

const fixture = name => JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8'));
const liveTest = existsSync(fileURLToPath(new URL('fixtures/', import.meta.url))) ? test : async name => console.log('  skip ' + name + ' (no test/fixtures)');

await liveTest('live fixtures: route lookup and both directions of 502', () => {
  eq(Core.findRoute(fixture('routes_BCM1.json'), '502'), { routeId: '502', color: '#FCD116', name: 'BOLHÃO-MATOSINHOS (MERCADO)' });
  const d0 = Core.normaliseRouteStops(fixture('route_502_dir0.json'));
  const d1 = Core.normaliseRouteStops(fixture('route_502_dir1.json'));
  eq(d0.map(x => x.code), stops.map(x => x.code));
  eq([d1.length, d1[0].id, d1.at(-1).id], [29, 'MATM2', 'BLRB2']);
});

await liveTest('live fixtures: 502 waiting at Bolhão is placed at the first stop', async () => {
  const d0 = Core.normaliseRouteStops(fixture('route_502_dir0.json'));
  const myIdx = d0.findIndex(x => x.id === 'BCM1');
  const fetchStop = async id => fixture(`walk-502-BCM1/rt_${id}.json`);
  const r = await Core.track({ fetchStop, stops: d0, myIdx, line: '502', count: 3, maxBack: 8 });
  eq([r.requests, r.errors.length, r.meta.data_source], [9, 0, 'realtime']);
  const [b, ...rest] = Core.locate({ obs: r.obs, stops: d0, myIdx, count: 3 });
  eq(rest, []);
  eq([b.tripId, b.state, b.nextIdx, b.nextMinutes, b.minutes, b.stopsAway, b.status], ['502_0_1|311|D1|T9|N9', 'terminus', 0, 12, 21, 8, 'ON_TIME']);
});

console.log(`\n${passed} passed`);
