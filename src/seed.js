// Demo seed. Everything marked PLACEHOLDER must be confirmed by the client.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open, helpers } = require('./db');
const C = require('./core');
const S = require('./services');

function seed(dbFile) {
  const file = dbFile || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'cockatoo.db');
  if (file !== ':memory:') for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true });
  const h = helpers(open(file));
  const today = C.todaySyd();
  const sys = { id: null, name: 'seed' };

  const settings = {
    business_name: ['Cockatoo Marine Pty Ltd', 1], abn: ['00 000 000 000', 1],
    bank_details: ['BSB 000-000 · Account 00000000 · Cockatoo Marine Pty Ltd', 1],
    phone: ['(02) 0000 0000', 1], address: ['Cockatoo Island, Sydney NSW 2000', 0],
    staff_email: ['office@cockatoomarine.example', 1], admin_email: ['admin@cockatoomarine.example', 1],
    deposit_type: ['fixed', 1], deposit_value: ['250', 1], hold_minutes: ['30', 0], pending_days: ['3', 0],
    lift_hours: ['07:00-16:00', 1], lift_slot_minutes: ['60', 1], lift_slot_capacity: ['2', 1], lift_blackouts: [C.addDays(today, 10), 1],
    tc_version: ['v1-draft', 1], base_url: [process.env.BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000'), 0],
  };
  for (const [k, [v, p]] of Object.entries(settings)) h.run('INSERT INTO settings (key,value,placeholder) VALUES (?,?,?)', k, v, p);

  // PLACEHOLDER rate table — "from $547/month" is the only confirmed figure.
  const bands = [[0, 6, 547], [6, 7.5, 627], [7.5, 9, 727], [9, 10.5, 847], [10.5, 12, 987]];
  for (const [min, max, base] of bands) {
    h.run('INSERT INTO rates (min_len,max_len,package,term,monthly_rate) VALUES (?,?,?,?,?)', min, max, 'standard', 'annual', base);
    h.run('INSERT INTO rates (min_len,max_len,package,term,monthly_rate) VALUES (?,?,?,?,?)', min, max, 'standard', 'monthly', base + 60);
    h.run('INSERT INTO rates (min_len,max_len,package,term,monthly_rate) VALUES (?,?,?,?,?)', min, max, 'unlimited', 'annual', base + 150);
    h.run('INSERT INTO rates (min_len,max_len,package,term,monthly_rate) VALUES (?,?,?,?,?)', min, max, 'unlimited', 'monthly', base + 210);
  }

  // PLACEHOLDER bays: 3 zones.
  const zones = [['A', 'Shed A (undercover)', 6, 8], ['B', 'Hardstand B', 8, 10], ['C', 'Hardstand C (large)', 12, 6]];
  for (const [z, name, max, n] of zones)
    for (let i = 1; i <= n; i++) h.run('INSERT INTO bays (code,zone,max_length_m) VALUES (?,?,?)', `${z}${String(i).padStart(2, '0')}`, name, max);
  h.run(`UPDATE bays SET status='out_of_service', notes='Slab repair pending' WHERE code='C06'`);

  const users = [
    ['admin@cockatoo.test', 'Alex Admin', 'admin'], ['office@cockatoo.test', 'Olivia Office', 'office'],
    ['yard@cockatoo.test', 'Yuri Yard', 'yard'], ['finance@cockatoo.test', 'Fran Finance', 'finance'],
  ];
  for (const [e, n, r] of users) h.run('INSERT INTO users (email,name,role,password_hash) VALUES (?,?,?,?)', e, n, r, C.hashPassword('demo1234'));

  const templates = {
    booking_confirmed: ['Your Cockatoo Marine booking {{ref}} is confirmed', 'Hi {{name}},\n\nYour dry boat storage booking {{ref}} is confirmed.\nBay: {{bay}}\nStart: {{start}}\nPackage: {{package}} · Term: {{term}}\nMonthly rate: {{rate}} (GST incl.)\nDeposit received: {{deposit}}\n\nView your booking summary: {{link}}\n\nCockatoo Marine'],
    booking_pending: ['Booking {{ref}} – deposit details', 'Hi {{name}},\n\nWe are holding your booking {{ref}} until {{expires}}.\nPlease pay the reservation fee of {{amount}} by bank transfer:\n{{bank}}\nUse {{ref}} as the reference.\n\nCockatoo Marine'],
    payment_reminder: ['Reminder: deposit for {{ref}} due', 'Hi {{name}},\n\nYour booking {{ref}} will be released at {{expires}} unless the {{amount}} reservation fee is received.\n\nCockatoo Marine'],
    booking_expired: ['Booking {{ref}} released', 'Hi {{name}},\n\nWe did not receive the reservation fee for {{ref}}, so the bay has been released. Reply to this email to start again.\n\nCockatoo Marine'],
    invoice_overdue: ['Invoice {{number}} is overdue', 'Hi {{name}},\n\nInvoice {{number}} has {{amount}} outstanding. You can pay online in your customer portal or by bank transfer.\n\nCockatoo Marine'],
    renewal_reminder: ['Your storage contract ends in {{days}} days', 'Hi {{name}},\n\nYour contract {{ref}} ends on {{end}}. Reply to renew or change your package.\n\nCockatoo Marine'],
    insurance_expiry: ['Insurance for {{boat}} expires {{expiry}}', 'Hi {{name}},\n\nOur records show insurance for {{boat}} expires on {{expiry}}. Please send us your renewed certificate.\n\nCockatoo Marine'],
    lift_confirmed: ['Lift booked for {{date}} at {{slot}}', 'Hi {{name}},\n\nYour lift is booked for {{date}} at {{slot}}. {{extra}}\n\nCockatoo Marine'],
    lift_reminder: ['Reminder: lift tomorrow at {{slot}}', 'Hi {{name}},\n\nSee you {{date}} at {{slot}}.\n\nCockatoo Marine'],
    staff_new_lead: ['New {{service}} enquiry from {{name}}', 'New enquiry #{{id}} from {{name}} via {{source}} ({{service}}).'],
    magic_link: ['Your Cockatoo Marine sign-in link', 'Hi {{name}},\n\nSign in to your customer portal: {{link}}\nThis link works for 30 minutes.'],
  };
  for (const [k, [s, b]] of Object.entries(templates)) h.run('INSERT INTO email_templates (key,subject,body) VALUES (?,?,?)', k, s, b);

  const items = (labels) => JSON.stringify(labels.map(([label, section, required = true, photo = false]) => ({ label, section, required, photo })));
  const common = [
    ['Hull condition', 'Hull', true, true], ['Antifoul condition', 'Hull'], ['Props / leg', 'Engine', true, true],
    ['Engine visual check', 'Engine'], ['Battery isolated', 'Engine'], ['Trailer tyres', 'Trailer', false], ['Trailer lights', 'Trailer', false],
    ['Bungs in', 'Safety'], ['Covers secured', 'Safety'], ['Safety gear present', 'Safety', false],
  ];
  h.run('INSERT INTO checklist_templates (name,type,items) VALUES (?,?,?)', 'Receiving / check-in', 'checkin', items([...common, ['Keys received', 'Handover']]));
  h.run('INSERT INTO checklist_templates (name,type,items) VALUES (?,?,?)', 'Release', 'release', items([...common, ['Keys handed over', 'Handover'], ['Customer ID checked', 'Handover']]));
  h.run('INSERT INTO checklist_templates (name,type,items) VALUES (?,?,?)', 'Return', 'return', items([...common, ['Keys returned', 'Handover'], ['Hull washed down', 'Hull']]));

  // Customers & boats
  const people = [
    ['Sam Taylor', 'sam.taylor@example.com', '0412 000 101', 'individual', null, 'website'],
    ['Priya Nair', 'priya.nair@example.com', '0412 000 102', 'individual', null, 'facebook'],
    ['Harbour Outings Co', 'bookings@harbouroutings.example', '0412 000 103', 'company', 'Harbour Outings Co', 'phone'],
    ['Jordan Lee', 'jordan.lee@example.com', '0412 000 104', 'individual', null, 'walk-in'],
    ['Morgan Chen', 'morgan.chen@example.com', '0412 000 105', 'individual', null, 'website'],
    ['Riley Brooks', 'riley.brooks@example.com', '0412 000 106', 'individual', null, 'facebook'],
  ];
  const boats = [
    ['Salty Dog', 'Runabout', 'Quintrex 540 Freestyler', 5.4, 'AU-QTX54012K607', 'ZA123N', '90hp Yamaha 4-stroke', 1, C.addDays(today, 20)],
    ['Wind Song', 'Half cabin', 'Haines Hunter 600R', 6.0, 'AU-HHM60034A708', 'ZB456N', '150hp Suzuki', 1, C.addMonths(today, 7)],
    ['Outing One', 'Centre console', 'Bar Crusher 780HT', 7.8, 'AU-BCR78011C809', 'ZC789N', 'Twin 150hp Yamaha', 0, C.addMonths(today, 4)],
    ['Blue Heeler', 'Bowrider', 'Sea Ray 210 SPX', 6.4, 'US-SERV2103B909', 'ZD321N', '250hp MerCruiser', 1, C.addMonths(today, 10)],
    ['Little Wren', 'Tinny', 'Stacer 429 Proline', 4.3, 'AU-STC42998D808', 'ZE654N', '30hp Mercury', 1, C.addMonths(today, 2)],
    ['Kestrel', 'Cruiser', 'Riviera 3600', 11.2, 'AU-RIV36077E707', 'ZF987N', 'Twin Cummins diesel', 0, C.addMonths(today, 8)],
  ];
  const custIds = [], boatIds = [];
  people.forEach(([n, e, p, kind, company, src], i) => {
    const c = h.run('INSERT INTO customers (kind,name,company,email,phone,source,tags,address) VALUES (?,?,?,?,?,?,?,?)',
      kind, n, company, e, p, src, i === 2 ? 'corporate,events' : '', 'Sydney NSW');
    custIds.push(Number(c.lastInsertRowid));
    const [bn, type, mm, len, hin, rego, eng, trailer, ins] = boats[i];
    const b = h.run(`INSERT INTO boats (customer_id,name,type,make_model,length_m,hin,rego,engine,trailer,trailer_details,insurer,insurance_policy,insurance_expiry,qr_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, custIds[i], bn, type, mm, len, hin, rego, eng, trailer, trailer ? 'Dunbier single axle' : null,
      'Club Marine', `CM-${1000 + i}`, ins, crypto.randomBytes(12).toString('base64url'));
    boatIds.push(Number(b.lastInsertRowid));
  });
  h.run('INSERT INTO users (email,name,role,password_hash,customer_id) VALUES (?,?,?,?,?)', 'sam.taylor@example.com', 'Sam Taylor', 'customer', C.hashPassword('demo1234'), custIds[0]);

  const bay = (code) => h.get('SELECT id FROM bays WHERE code=?', code).id;
  const q = (len, pkg, term) => S.getQuote(h, { lengthM: len, pkg, term });
  const mk = (i, code, pkg, term, start, status) => {
    const qq = q(boats[i][3], pkg, term);
    return S.createBooking(h, { bay_id: bay(code), customer_id: custIds[i], boat_id: boatIds[i], package: pkg, term, monthly_rate: qq.monthly,
      start_date: start, end_date: S.bookingEnd(start, term), status, deposit_amount: qq.deposit }, sys);
  };
  const b1 = mk(0, 'A01', 'standard', 'annual', C.addMonths(today, -5), 'active');
  const b2 = mk(1, 'A02', 'unlimited', 'annual', C.addMonths(today, -10), 'active'); // ends in ~2 months → renewal
  const b3 = mk(2, 'B01', 'unlimited', 'monthly', C.addMonths(today, -2), 'active'); // ends in ~1 month
  const b4 = mk(3, 'B02', 'standard', 'monthly', C.addDays(today, 14), 'confirmed');
  const b6 = mk(5, 'C01', 'standard', 'annual', C.addMonths(today, -3), 'active');
  for (const b of [b1, b2, b3, b4, b6]) S.updateBooking(h, b.id, { deposit_paid: 1 }, sys);
  // Manual-payment booking awaiting deposit
  const qq5 = q(4.3, 'standard', 'monthly');
  const b5 = S.createBooking(h, { bay_id: bay('A03'), customer_id: custIds[4], boat_id: boatIds[4], package: 'standard', term: 'monthly',
    monthly_rate: qq5.monthly, start_date: C.addDays(today, 7), end_date: S.bookingEnd(C.addDays(today, 7), 'monthly'), status: 'pending',
    pending_expires_at: new Date(Date.now() + 20 * 3600e3).toISOString(), deposit_amount: qq5.deposit }, sys);

  for (const b of [b1, b2, b3, b4, b6]) h.run(`INSERT INTO contracts (booking_id,customer_id,term,package,monthly_rate,start_date,end_date,tc_version,tc_accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    b.id, b.customer_id, b.term, b.package, b.monthly_rate, b.start_date, b.end_date, 'v1-draft', b.start_date + 'T09:00:00.000Z');

  // More demo customers so occupancy and reports look realistic.
  const more = [['Alex Morgan', 'A04', 5.2, 'Quintrex 490 Hornet'], ['Jesse Walker', 'A05', 5.8, 'Haines Hunter 565'], ['Pat Kelly', 'A06', 4.8, 'Stacer 469 Bay Master'], ['Charlie Nguyen', 'A07', 5.9, 'Bayliner VR5'],
    ['Robin Singh', 'B03', 7.2, 'Whittley CR2180'], ['Taylor Brooks', 'B04', 6.8, 'Sea Ray 230'], ['Sydney Harbour Tours', 'C04', 8.5, 'Riviera 2800'], ['Dana Ellis', 'B07', 6.5, 'Haines Hunter 625'],
    ['Kim Rossi', 'C02', 10.4, 'Mustang 32'], ['Lee Parker', 'C03', 9.8, 'Riviera 3000'], ['Max Hughes', 'B08', 7.4, 'Bar Crusher 670C'], ['Quinn Adams', 'A08', 5.5, 'Brooker 535']];
  more.forEach(([n, code, len, mm], i) => {
    const email = n.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com';
    const cid = Number(h.run('INSERT INTO customers (kind,name,email,phone,source) VALUES (?,?,?,?,?)', n.includes('Tours') ? 'company' : 'individual', n, email, `0413 000 ${200 + i}`, ['website', 'facebook', 'phone', 'walk-in'][i % 4]).lastInsertRowid);
    const bid = Number(h.run('INSERT INTO boats (customer_id,name,make_model,length_m,insurance_expiry,qr_token) VALUES (?,?,?,?,?,?)', cid, mm.split(' ')[0] + ' ' + (i + 1), mm, len, C.addMonths(today, 3 + i), crypto.randomBytes(12).toString('base64url')).lastInsertRowid);
    const pkg = i % 3 === 0 ? 'unlimited' : 'standard', term = i % 4 === 1 ? 'monthly' : 'annual';
    const start = C.addMonths(today, -(1 + (i % 8)));
    const qq = q(len, pkg, term);
    const bk = S.createBooking(h, { bay_id: bay(code), customer_id: cid, boat_id: bid, package: pkg, term, monthly_rate: qq.monthly, start_date: start, end_date: S.bookingEnd(start, term, term === 'monthly' ? 6 : 12), status: 'active', deposit_amount: qq.deposit }, sys);
    S.updateBooking(h, bk.id, { deposit_paid: 1 }, sys);
    h.run(`INSERT INTO leads (customer_id,name,email,service,source,stage,created_at) VALUES (?,?,?,?,?,?,?)`, cid, n, email, 'storage', ['website', 'facebook', 'phone', 'walk-in'][i % 4], 'booked', start + 'T00:00:00.000Z');
  });

  // Maintenance block on a bay
  S.createBooking(h, { kind: 'maintenance', bay_id: bay('B05'), start_date: C.addDays(today, 3), end_date: C.addDays(today, 6), status: 'maintenance', notes: 'Drainage regrade' }, sys);

  // Leads pipeline
  const leads = [
    ['Casey Morgan', 'casey@example.com', '0400 111 222', 'storage', 'facebook', 'new', 'Messenger: 6.5m Haines, wants annual unlimited'],
    ['Taylor Quinn', 'tquinn@example.com', '0400 333 444', 'antifoul', 'website', 'contacted', 'Antifoul for 7m cruiser before summer'],
    ['Avery Patel', 'avery@example.com', '0400 555 666', 'storage', 'phone', 'quoted', 'Called about 5.8m runabout, monthly'],
    ['Morgan Chen', 'morgan.chen@example.com', '0412 000 105', 'storage', 'website', 'deposit_pending', 'Online booking – bank transfer'],
    ['Drew Wilson', 'drew@example.com', '0400 777 888', 'events', 'website', 'lost', 'Corporate event for 40 guests'],
    ['Jamie Fox', 'jamie@example.com', '0400 999 000', 'marina', 'walk-in', 'new', 'Asked about marina berth availability'],
  ];
  for (const [n, e, p, svc, src, stage, msg] of leads) {
    const id = S.createLead(h, { name: n, email: e, phone: p, service: svc, source: src, stage, message: msg }, sys);
    if (stage === 'lost') h.run(`UPDATE leads SET lost_reason='Went with a competitor (price)' WHERE id=?`, id);
    if (n === 'Morgan Chen') { h.run('UPDATE leads SET customer_id=? WHERE id=?', custIds[4], id); h.run('UPDATE bookings SET lead_id=? WHERE id=?', id, b5.id); }
  }
  h.run(`UPDATE leads SET customer_id=? WHERE email='sam.taylor@example.com'`, custIds[0]);
  for (const [cid, src] of [[custIds[0], 'website'], [custIds[1], 'facebook'], [custIds[2], 'phone'], [custIds[3], 'walk-in'], [custIds[5], 'facebook']])
    h.run(`INSERT INTO leads (customer_id,name,email,service,source,stage,created_at) SELECT id,name,email,'storage',?,'booked',? FROM customers WHERE id=?`, src, C.addMonths(today, -6) + 'T00:00:00.000Z', cid);

  // Lifts: Sam (standard) has 2 this month already, third would be extra
  const thisMonth = today.slice(0, 8);
  h.run(`INSERT INTO lifts (booking_id,boat_id,date,slot,status) VALUES (?,?,?,?,?)`, b1.id, boatIds[0], thisMonth + '02', '08:00', 'done');
  h.run(`INSERT INTO lifts (booking_id,boat_id,date,slot,status) VALUES (?,?,?,?,?)`, b1.id, boatIds[0], thisMonth + '05', '09:00', 'done');
  try { S.bookLift(h, { booking_id: b1.id, date: C.addDays(today, 1), slot: '08:00' }, sys); } catch { /* blackout/month edge */ }
  try { S.bookLift(h, { booking_id: b2.id, date: C.addDays(today, 1), slot: '08:00', engine_flush: 1 }, sys); } catch {}
  try { S.bookLift(h, { booking_id: b3.id, date: today, slot: '10:00' }, sys); } catch {}
  // Last month extra lift → appears in arrears on next invoice
  const lastMonth = C.addMonths(C.monthStart(today), -1);
  h.run(`INSERT INTO extras (booking_id,customer_id,date,description,category,amount_inc) VALUES (?,?,?,?,?,?)`, b1.id, custIds[0], C.addDays(lastMonth, 17), 'Extra lift', 'extra_lift', 30);

  // Invoices: previous months (paid) + this month (some unpaid/overdue)
  for (let m = -3; m <= 0; m++) {
    const period = C.addMonths(C.monthStart(today), m).slice(0, 7);
    const created = S.runMonthlyInvoicing(h, period, sys);
    for (const inv of created) {
      h.run('UPDATE invoices SET issue_date=?, due_date=? WHERE id=?', `${period}-01`, C.addDays(`${period}-01`, 7), inv.id);
      const unpaid = m === 0 && (inv.customer_id === custIds[2] || inv.customer_id === custIds[5]);
      if (unpaid && inv.customer_id === custIds[5]) h.run('UPDATE invoices SET due_date=? WHERE id=?', C.addDays(today, -3), inv.id);
      if (!unpaid) S.recordPayment(h, { invoice_id: inv.id, customer_id: inv.customer_id, amount: inv.total, method: m % 2 ? 'bank_transfer' : 'stripe', reference: `SEED-${inv.number}`, paid_on: C.addDays(`${period}-01`, 2) }, sys);
    }
  }
  // Service job (antifoul) invoiced
  h.run(`INSERT INTO service_jobs (customer_id,boat_id,service,description,quote_amount,scheduled_date,assigned_to,parts,parts_cost,labour_hours,labour_rate,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, custIds[3], boatIds[3], 'antifoul', 'Full antifoul, anodes, polish topsides', 1650, C.addDays(today, 5), 3, 'Antifoul paint 4L x2, anodes', 420, 12, 95, 'scheduled');
  h.run(`INSERT INTO service_jobs (customer_id,boat_id,service,description,quote_amount,scheduled_date,status) VALUES (?,?,?,?,?,?,?)`,
    custIds[1], boatIds[1], 'maintenance', 'Annual engine service', 690, C.addDays(today, -12), 'done');

  // Facility maintenance
  const assets = [['Travel hoist 25t', 'equipment'], ['Forklift (boat stacker)', 'equipment'], ['Wash-down bay', 'facility'], ['Bay B05', 'bay']];
  for (const [n, t] of assets) h.run('INSERT INTO assets (name,type,bay_id) VALUES (?,?,?)', n, t, t === 'bay' ? bay('B05') : null);
  h.run(`INSERT INTO maintenance_jobs (asset_id,title,kind,due_date,recur_days,status) VALUES (1,'Hoist slings inspection','scheduled',?,90,'open')`, C.addDays(today, 4));
  h.run(`INSERT INTO maintenance_jobs (asset_id,title,kind,due_date,recur_days,status) VALUES (2,'Forklift service','scheduled',?,180,'open')`, C.addDays(today, -2));
  h.run(`INSERT INTO maintenance_jobs (asset_id,title,kind,due_date,status,notes) VALUES (3,'Pressure washer leaking','reactive',?,'in_progress','Replace hose fitting')`, today);
  h.run(`INSERT INTO maintenance_jobs (asset_id,title,kind,due_date,status,block_booking_id) VALUES (4,'Drainage regrade','reactive',?,'open',(SELECT id FROM bookings WHERE kind='maintenance' LIMIT 1))`, C.addDays(today, 3));

  // Expenses (3 months)
  const exp = [['Electricity', 'Ausgrid', 880], ['Wages', 'Payroll', 9200], ['Fuel', 'Ampol', 410], ['Repairs', 'Harbour Hydraulics', 1240], ['Insurance', 'Marsh', 1500], ['Lease', 'Harbour Trust', 6500]];
  for (let m = -3; m <= 0; m++) for (const [cat, sup, amt] of exp) {
    const a = Math.round(amt * (0.9 + ((m + 4) * 7 % 3) / 10));
    h.run('INSERT INTO expenses (date,category,supplier,description,amount_inc,gst) VALUES (?,?,?,?,?,?)',
      C.addDays(C.addMonths(C.monthStart(today), m), 12), cat, sup, `${cat} – monthly`, a, cat === 'Wages' ? 0 : C.gstOf(a));
  }

  // Checklists: check-in, release (out now) for Salty Dog; release+return with a difference for Wind Song
  const res = (overrides = {}) => JSON.stringify(Object.fromEntries(JSON.parse(h.get('SELECT items FROM checklist_templates WHERE type=?', 'release').items)
    .map((it) => [it.label, { status: overrides[it.label] || 'pass', note: '' }])));
  h.run(`INSERT INTO checklists (type,template_id,boat_id,booking_id,customer_id,staff_id,results,inventory,fuel_level,damage_notes,signed_name,created_at) VALUES ('checkin',1,?,?,?,3,?,?,?,?,?,?)`,
    boatIds[0], b1.id, custIds[0], res(), 'Life jackets x4, anchor, flares (exp 2027), fire extinguisher, esky', '3/4', 'Scuff port bow', 'Sam Taylor', C.addMonths(today, -5) + 'T01:00:00.000Z');
  const rel = h.run(`INSERT INTO checklists (type,template_id,boat_id,booking_id,customer_id,staff_id,results,inventory,fuel_level,released_to,signed_name,created_at) VALUES ('release',2,?,?,?,3,?,?,?,?,?,?)`,
    boatIds[1], b2.id, custIds[1], res(), 'Life jackets x6, anchor, VHF', 'Full', 'Priya Nair', 'Priya Nair', C.addDays(today, -6) + 'T22:00:00.000Z');
  h.run(`INSERT INTO checklists (type,template_id,boat_id,booking_id,customer_id,staff_id,results,inventory,fuel_level,damage_notes,release_id,signed_name,created_at) VALUES ('return',3,?,?,?,3,?,?,?,?,?,?,?)`,
    boatIds[1], b2.id, custIds[1], res({ 'Props / leg': 'fail', 'Hull condition': 'fail' }), 'Life jackets x6, VHF (anchor missing)', '1/4', 'Prop ding, gelcoat chip starboard', rel.lastInsertRowid, 'Priya Nair', C.addDays(today, -5) + 'T06:00:00.000Z');
  h.run(`INSERT INTO checklists (type,template_id,boat_id,booking_id,customer_id,staff_id,results,inventory,fuel_level,released_to,signed_name,created_at) VALUES ('release',2,?,?,?,3,?,?,?,?,?,?)`,
    boatIds[0], b1.id, custIds[0], res(), 'Life jackets x4, anchor, flares', '3/4', 'Sam Taylor', 'Sam Taylor', today + 'T00:30:00.000Z');

  // Watchlist (fictional) + a lead that triggers it
  h.run(`INSERT INTO watchlist (name,email,phone,rego,hin,reason,evidence,added_by) VALUES (?,?,?,?,?,?,?,1)`,
    'Chris Fakename', 'chris.f@example.net', '0499 123 456', 'ZZ999N', null, 'Non-payment', 'Left 3 months unpaid in 2025; debt referred to collector (ref COL-118).');
  S.createLead(h, { name: 'Kris Fakename', email: 'k.fake@example.net', phone: '+61 499 123 456', service: 'storage', source: 'website', message: '7m boat, wants to start next week' }, sys);

  h.run(`INSERT INTO communications (customer_id,channel,direction,summary,user_id) VALUES (?,?,?,?,2)`, custIds[1], 'messenger', 'in', 'Asked to move lift to Saturday morning');
  h.run(`INSERT INTO integrations (provider,kind,enabled) VALUES ('stripe','payments',?),('open-meteo','weather',1),('ga4','analytics',?),('messenger','messaging',0),('xero','accounting',0),('sms','notifications',0)`,
    process.env.STRIPE_SECRET_KEY ? 1 : 0, process.env.GA4_ID ? 1 : 0);

  S.runScheduledJobs(h);
  return h;
}

module.exports = { seed };
if (require.main === module) { seed(); console.log('Seeded demo data. Staff logins: admin|office|yard|finance@cockatoo.test / demo1234 · Customer: sam.taylor@example.com / demo1234'); }
