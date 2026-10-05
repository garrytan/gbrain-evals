/**
 * Word and value pools for the sealed Hard generator. Every company, person
 * and place here is fictional.
 */

export const COMPANY = 'Verrowind Systems';
export const COMPANY_DOMAIN = 'verrowind.example';
export const PRINCIPAL = { name: 'Odile Farrant', role: 'Director of Account Operations, Verrowind Systems' };

/** Verrowind account leads (the H1 `owner` values). */
export const STAFF = [
  'Ilse Marrow', 'Tobiah Quill', 'Annick Brede', 'Caspar Doyle-Wynn', 'Mireille Osei', 'Henrik Lauda',
  'Saoirse Pell', 'Rafferty Imre', 'Yusra Kettle', 'Bastian Corr', 'Leocadia Finn', 'Morwen Talbet',
] as const;

/** Verrowind people who write routine mail and attend meetings but never lead accounts. */
export const SUPPORT_STAFF = ['Dov Aranha', 'Phaedra Lusk', 'Emrys Okonjo', 'Tilde Varga', 'Kasimir Bell', 'Nell Ardoin'] as const;

export const SEGMENTS = ['Strategic', 'Growth', 'Foundation'] as const;
export const REGIONS = ['Highlands', 'Coastline', 'Lakeshore', 'Delta'] as const;

/** Pieces of invented first words for customer names. */
export const ONSETS = ['Vas', 'Pel', 'Dru', 'Ost', 'Kel', 'Mar', 'Tor', 'Bry', 'Quen', 'Zal', 'Hov', 'Lin', 'Fen', 'Gar', 'Rud', 'Sel', 'Wex', 'Yar', 'Cal', 'Nim', 'Brev', 'Dav', 'Ister', 'Jorv', 'Plim', 'Sorr', 'Thal', 'Ulm', 'Vint', 'Erd'] as const;
export const MIDS = ['a', 'e', 'i', 'o', 'u', 'ar', 'en', 'il'] as const;
export const CODAS = ['kor', 'lin', 'mora', 'by', 'vane', 'dell', 'ross', 'wick', 'ara', 'sted', 'holm', 'ix', 'oro', 'ent', 'ley', 'mere', 'ath', 'quist', 'nor', 'tava'] as const;
export const TRADES = [
  'Dairy Cooperative', 'Instruments', 'Freightways', 'Clinics', 'Textile Mills', 'Brewing', 'Ceramics', 'Orchards', 'Tooling', 'Pharmacy Group',
  'Marine Supply', 'Grain Elevators', 'Print Works', 'Cold Storage', 'Robotics', 'Seed Bank', 'Water Board', 'Glassworks', 'Timber', 'Optics',
] as const;

/** Customer-side people. */
export const GIVEN = ['Petra', 'Joss', 'Ruben', 'Calla', 'Idris', 'Marit', 'Oskar', 'Wilma', 'Teodor', 'Abena', 'Lucan', 'Fenna', 'Gideon', 'Halvard', 'Ines', 'Jarrah', 'Kerensa', 'Lorcan', 'Maelle', 'Niamh', 'Orrin', 'Priya', 'Quilla', 'Rosalind', 'Stellan', 'Tamsin', 'Ulrike', 'Vashti', 'Wendell', 'Xanthe', 'Yorick', 'Zuleika'] as const;
export const FAMILY = ['Loam', 'Merrin', 'Tash', 'Brannock', 'Coyle', 'Dunmore', 'Esterhazy', 'Fairweather', 'Gallimore', 'Hext', 'Iverach', 'Jolliffe', 'Kitto', 'Lisle', 'Mabry', 'Nankervis', 'Ormsby', 'Pendry', 'Quarrie', 'Rendle', 'Sowden', 'Trevail', 'Uglow', 'Vosper', 'Wenmoth', 'Yeo'] as const;

/** Sites for H5 routing. */
export const SITE_WORDS = ['Halden', 'Osk', 'Brightwater', 'Carrow', 'Dunlin', 'Eskdale', 'Fallowfield', 'Greystone', 'Hollin', 'Kestle', 'Lowmoor', 'Millrace'] as const;
export const SITE_KINDS = ['depot', 'plant', 'yard', 'annex', 'works'] as const;

/**
 * Order-form attributes that change over time (H2) or tell look-alikes
 * apart (H3). No value in a pool is a substring of another after
 * normalization.
 */
export const ATTRIBUTES = {
  'payment terms': { label: 'Payment terms', values: ['Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 75', 'Net 90'] },
  'support plan': { label: 'Support plan', values: ['Copper', 'Pewter', 'Bronze', 'Silver', 'Cobalt', 'Platinum'] },
  'data retention': { label: 'Data retention', values: ['18 months', '24 months', '36 months', '48 months', '60 months', '84 months'] },
} as const;
export type AttrKind = keyof typeof ATTRIBUTES;
export const H2_ATTRS: readonly AttrKind[] = ['payment terms', 'data retention'];
export const H3_ATTRS: readonly AttrKind[] = ['payment terms', 'support plan', 'data retention'];

/** Contract terms that executed and unexecuted documents disagree about (H4). */
export const TERMS = {
  'termination notice': { label: 'Termination notice', values: ['30 days', '45 days', '60 days', '75 days', '90 days', '150 days'] },
  'seat price': { label: 'Price per seat', values: ['$38', '$44', '$51', '$57', '$63', '$69'] },
  'liability cap': { label: 'Liability cap', values: ['$150,000', '$275,000', '$400,000', '$525,000', '$650,000', '$800,000'] },
  'uptime commitment': { label: 'Uptime commitment', values: ['99.0%', '99.5%', '99.7%', '99.8%', '99.9%', '99.95%'] },
} as const;
export type TermKind = keyof typeof TERMS;
export const TERM_KINDS = Object.keys(TERMS) as TermKind[];

/** Subjects of routine correspondence, minutes and bulletins. None of them sets a predicate value. */
export const TOPICS = [
  'loading dock access badges', 'invoice copy for their auditors', 'training slots for new hires', 'API sandbox credentials', 'holiday shipping schedule',
  'quarterly usage export', 'visitor parking for the site walk', 'single sign-on certificate rotation', 'translated user guide', 'replacement sensor kit',
  'dashboard colour scheme', 'calibration certificates', 'spare gateway units', 'floor plan for the new wing', 'webhook retry settings',
  'insurance certificate request', 'data export to their analysts', 'warehouse label printer', 'night shift handover screen', 'tablet mounting brackets',
] as const;

export const TICKET_SUMMARIES = [
  'Sensor readings drift after the firmware update', 'Nightly export job stops at 80%', 'Tablet app loops back to the login screen', 'Duplicate alerts for one gateway',
  'Report totals differ between the web and the PDF', 'Badge reader rejects new cards', 'Map view loads without site pins', 'Webhook deliveries arrive out of order',
  'Password reset email never arrives', 'Time zone wrong on shift reports', 'Bulk upload rejects valid CSV rows', 'Gateway reboots every few hours',
] as const;
