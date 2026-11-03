/**
 * Name and phrase banks for world-v3 (skillopt-method-v3, GBEV-30). Pure data:
 * world-v3.ts draws every name and every filler sentence from here with its
 * seeded generator, so the world regenerates byte for byte.
 *
 * Rules the banks keep, because the scorer and the oracles rely on them:
 *   - no entity name contains a period, so no name can end a sentence early;
 *   - no first name is a month or an English word the prose uses;
 *   - no surname or stem is a word the scorer reads as a key (page, price,
 *     notice, term, tier, seat, status, claim, source, brain);
 *   - no filler sentence contains a digit or a form of "found", so filler
 *     never states a number a task asks for or a founding a task denies.
 */

export const FIRST_NAMES = [
  'Maren', 'Dev', 'Priya', 'Tomas', 'Ines', 'Kofi', 'Leandra', 'Rafael', 'Signe', 'Omar', 'Yuki', 'Elif', 'Bram', 'Noor', 'Callum', 'Ayesha',
  'Mateo', 'Freya', 'Hiro', 'Lucia', 'Anders', 'Zainab', 'Teodor', 'Mira', 'Kwame', 'Isolde', 'Ravi', 'Sunniva', 'Dario', 'Nadia', 'Emeka', 'Liesel',
  'Arjun', 'Carys', 'Felipe', 'Hana', 'Joaquin', 'Katya', 'Lorcan', 'Malia', 'Niall', 'Odette', 'Pavel', 'Rosalind', 'Santiago', 'Talia', 'Ulrich', 'Vesna',
  'Wendell', 'Ximena', 'Yara', 'Zoltan', 'Adaeze', 'Bjorn', 'Celeste', 'Dmitri', 'Esme', 'Farid', 'Greta', 'Hamish', 'Ilse', 'Jovan', 'Kirsi', 'Lionel',
  'Marisol', 'Nikhil', 'Orla', 'Pieter', 'Renata', 'Soren', 'Tamsin', 'Umar', 'Valeria', 'Wim', 'Yusuf', 'Zofia', 'Alder', 'Bettina', 'Cormac', 'Delphine',
  'Eamon', 'Fenna', 'Gideon', 'Hedda', 'Idris', 'Jessamy', 'Kalani', 'Linnea', 'Magnus', 'Nerys', 'Otto', 'Paloma', 'Rohan', 'Saoirse', 'Tobias', 'Ulla',
  'Viggo', 'Xavier', 'Yvette', 'Zeno', 'Anouk', 'Cosima', 'Darius', 'Elodie', 'Florian', 'Gwen', 'Horatio', 'Ingrid', 'Jonas', 'Keziah', 'Leopold', 'Mathilde',
  'Nils', 'Oona', 'Percival', 'Rhea', 'Stellan', 'Thea', 'Ugo', 'Vivienne', 'Waleed', 'Yannick', 'Zara', 'Amara', 'Benedikt', 'Clio', 'Desmond', 'Elke',
  'Fintan', 'Giulia', 'Henrik', 'Ione', 'Jasper', 'Kalinda', 'Lars', 'Mireille', 'Nico', 'Ottilie', 'Philippa', 'Ruben', 'Sabine', 'Tycho', 'Veda', 'Wolfram',
  'Yasmin', 'Aurelio', 'Brigid', 'Cyrus', 'Dagny', 'Emrys', 'Fleur', 'Gaspard', 'Halima', 'Ignatius', 'Jorunn', 'Kasimir', 'Lavinia', 'Mads', 'Nanami', 'Osric',
];

export const SURNAMES = [
  'Okafor', 'Lindqvist', 'Ferreira', 'Nakamura', 'Abernathy', 'Castellanos', 'Dubois', 'Eriksen', 'Fairbanks', 'Gallagher', 'Haddad', 'Ibarra', 'Jankowski',
  'Kowalski', 'Lachance', 'Mbeki', 'Novak', 'Oyelaran', 'Pacheco', 'Quintero', 'Rasmussen', 'Sandoval', 'Takahashi', 'Underhill', 'Valdivia', 'Whitcombe',
  'Yamada', 'Zelenko', 'Achebe', 'Bergstrom', 'Chaudhry', 'Delacroix', 'Esposito', 'Fontaine', 'Gutierrez', 'Halloran', 'Iversen', 'Jaramillo', 'Kaminski',
  'Lombardi', 'Moreau', 'Nwosu', 'Ostrowski', 'Pellegrini', 'Quigley', 'Rourke', 'Szabo', 'Tremblay', 'Ulloa', 'Vasquez', 'Wojcik', 'Xiong', 'Yilmaz',
  'Zamora', 'Alvarado', 'Brandt', 'Ciccone', 'Dimitrov', 'Ekstrom', 'Falkenberg', 'Grimaldi', 'Hollis', 'Ishikawa', 'Jovanovic', 'Kearney', 'Lucero',
  'Mancini', 'Navarro', 'Oduya', 'Piccolo', 'Radcliffe', 'Salazar', 'Thibodeaux', 'Urquhart', 'Vreeland', 'Waverly', 'Yoshida', 'Zielinski', 'Ashdown',
  'Bianchi', 'Corrigan', 'Dalgaard', 'Escobar', 'Fennimore', 'Gaskell', 'Holloway', 'Ingram', 'Jessup', 'Kilbride', 'Laramie', 'Mulvaney', 'Nakashima',
  'Ormsby', 'Prendergast', 'Rinaldi', 'Stavros', 'Tolliver', 'Uchida', 'Varga', 'Wexford', 'Yancey', 'Zubiri', 'Amundsen', 'Beaumont', 'Crowther',
  'Dunleavy', 'Eastwood', 'Farrow', 'Galloway', 'Hargreaves', 'Iwasaki', 'Jardine', 'Kerrigan', 'Lockhart', 'Montague', 'Nakagawa', 'Oyama', 'Pemberton',
  'Ramsden', 'Sorensen', 'Thackeray', 'Upton', 'Vance', 'Westerberg', 'Yardley', 'Zawadzki', 'Aldana', 'Blackwood', 'Carvalho', 'Drummond', 'Elling',
  'Fitzroy', 'Greaves', 'Hendricks', 'Ilic', 'Juarez', 'Kincaid', 'Lindgren', 'Moriarty', 'Nordin', 'Oakes', 'Palmieri', 'Renwick', 'Sheridan', 'Tanaka',
  'Valente', 'Whitlock', 'Yorke', 'Zeller', 'Arceneaux', 'Bellamy', 'Coutinho', 'Desai', 'Engstrom', 'Forsythe', 'Gilchrist', 'Huxley', 'Imbert',
  'Kovac', 'Larkin', 'Mendes', 'Nygaard', 'Okonjo', 'Penhallow', 'Rademacher', 'Tavares', 'Vidal', 'Winslow', 'Yeager', 'Zhou', 'Adebayo', 'Bjork',
  'Cardenas', 'Dorsey', 'Ellison', 'Fukuda', 'Gorski', 'Hammond', 'Inoue', 'Kristiansen', 'Lawson', 'Murakami', 'Nunez', 'Ortega', 'Petrov', 'Rhodes',
  'Sato', 'Thorne', 'Varela', 'Whitaker', 'Albrecht', 'Bonaventure', 'Cavendish', 'Dragomir', 'Etxeberria', 'Fiorentino', 'Gunnarsson', 'Hashemi',
  'Isaksen', 'Kapoor', 'Lindahl', 'Marchetti', 'Nakano', 'Obradovic', 'Pryce', 'Quarles', 'Rosales', 'Stromberg', 'Tamura', 'Villanueva', 'Wakefield',
];

/** Surname pairs one letter or so apart: each pair gives two people with one first name (Maren Holt, Maren Holte). */
export const NEAR_SURNAME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Holt', 'Holte'], ['Marsh', 'Marsch'], ['Lind', 'Linde'], ['Carlsen', 'Carlson'], ['Petersen', 'Peterson'], ['Reid', 'Reade'],
  ['Thomsen', 'Thomson'], ['Fischer', 'Fisher'], ['Meyer', 'Meier'], ['Hansen', 'Hanson'], ['Kramer', 'Kraemer'], ['Nyberg', 'Nyborg'],
  ['Andersen', 'Anderson'], ['Christensen', 'Christenson'], ['Schmitt', 'Schmidt'], ['Neville', 'Nevill'],
];

/** Syllables that build company and account stems (Corvane, Halbridge). */
export const STEM_HEADS = ['Cor', 'Hal', 'Pel', 'Star', 'Brin', 'Wex', 'Kel', 'Quen', 'Tol', 'Fern', 'Ost', 'Glim', 'Var', 'Luns', 'Ash', 'Bel', 'Cal', 'Dun', 'Elm', 'Fal', 'Gar', 'Ivo', 'Jor', 'Kest', 'Lor', 'Nor', 'Orr', 'Pen', 'Rav', 'Sel', 'Tav', 'Ves', 'Wyn', 'Yar', 'Zel', 'Bram', 'Cin', 'Dra', 'Eld', 'Fen', 'Gry', 'Hask', 'Isen', 'Jun', 'Kor', 'Lum', 'Mor', 'Nest', 'Oak', 'Pra', 'Quill', 'Rook', 'Sab', 'Thal', 'Umb', 'Vel', 'Wil', 'Yew', 'Zan'];
export const STEM_TAILS = ['vane', 'bridge', 'mora', 'low', 'cote', 'moor', 'line', 'field', 'by', 'vale', 'castle', 'val', 'ton', 'wick', 'ford', 'mere', 'gate', 'haven', 'stead', 'ridge', 'holm', 'burn', 'well', 'combe', 'shaw', 'hurst', 'dale', 'thorne', 'brook', 'crest', 'fell', 'ley', 'wyn', 'ora', 'ia', 'ix', 'ent', 'ara', 'elle', 'ion'];

/** Company suffix, the industry it implies, and what such a company makes. */
export const COMPANY_KINDS: ReadonlyArray<{ suffix: string; industry: string; products: readonly string[]; customers: readonly string[] }> = [
  { suffix: 'Robotics', industry: 'robotics', products: ['picking arms for small warehouses', 'autonomous carts for factory floors', 'inspection drones for storage yards'], customers: ['regional distributors', 'contract manufacturers', 'third-party warehouses'] },
  { suffix: 'Analytics', industry: 'data analytics', products: ['demand forecasting dashboards', 'pricing analytics for wholesalers', 'route profitability reports'], customers: ['mid-sized retailers', 'wholesale distributors', 'regional carriers'] },
  { suffix: 'Health', industry: 'digital health', products: ['remote monitoring for clinics', 'scheduling software for physiotherapists', 'care coordination tools'], customers: ['independent clinics', 'regional hospital groups', 'home care agencies'] },
  { suffix: 'Labs', industry: 'developer tools', products: ['test automation for mobile teams', 'build caching for large repositories', 'feature flag tooling'], customers: ['software teams at mid-sized companies', 'agencies that ship mobile apps', 'platform teams'] },
  { suffix: 'Logistics', industry: 'logistics software', products: ['dispatch boards for regional fleets', 'freight audit tools', 'last-mile routing'], customers: ['regional fleets', 'freight brokers', 'parcel networks'] },
  { suffix: 'Systems', industry: 'industrial software', products: ['maintenance planning for plants', 'quality tracking for assembly lines', 'energy metering for factories'], customers: ['plant managers', 'contract manufacturers', 'utilities'] },
  { suffix: 'Biotech', industry: 'biotechnology', products: ['enzyme assays for food labs', 'cell culture media', 'diagnostic reagents'], customers: ['contract research labs', 'university labs', 'food safety labs'] },
  { suffix: 'Networks', industry: 'network infrastructure', products: ['private wireless for warehouses', 'edge routers for retail sites', 'network monitoring'], customers: ['multi-site retailers', 'campus operators', 'logistics parks'] },
  { suffix: 'Energy', industry: 'energy storage', products: ['battery systems for depots', 'charging management for fleets', 'solar monitoring'], customers: ['fleet operators', 'commercial landlords', 'municipal utilities'] },
  { suffix: 'Foods', industry: 'food technology', products: ['plant-based dairy ingredients', 'shelf-life testing', 'kitchen inventory software'], customers: ['grocery chains', 'restaurant groups', 'food manufacturers'] },
  { suffix: 'Materials', industry: 'advanced materials', products: ['recycled packaging films', 'coatings for cold rooms', 'lightweight composites'], customers: ['packaging converters', 'cold storage builders', 'equipment makers'] },
  { suffix: 'Security', industry: 'cybersecurity', products: ['access reviews for mid-sized firms', 'phishing simulation', 'device inventory'], customers: ['regional banks', 'healthcare networks', 'manufacturers'] },
  { suffix: 'Mobility', industry: 'mobility', products: ['fleet telematics', 'shared scooter operations', 'driver scheduling'], customers: ['city operators', 'delivery fleets', 'campus shuttles'] },
  { suffix: 'Payments', industry: 'payments', products: ['invoice financing for suppliers', 'card issuing for fleets', 'payout automation'], customers: ['wholesale suppliers', 'fleet operators', 'marketplaces'] },
  { suffix: 'Learning', industry: 'education technology', products: ['training content for warehouse staff', 'certification tracking', 'onboarding courses'], customers: ['distribution centers', 'retail chains', 'trade schools'] },
  { suffix: 'Studios', industry: 'creative software', products: ['product photography tools', 'catalog layout software', 'video editing for retail'], customers: ['catalog retailers', 'marketing agencies', 'brand teams'] },
];

export const INVESTOR_SUFFIXES = ['Capital', 'Ventures'] as const;

/** Customer account suffixes: the vendor's customers run physical operations. */
export const ACCOUNT_SUFFIXES = ['Cold Storage', 'Freight', 'Distribution', 'Fulfillment', 'Packaging', 'Supply', 'Grocers', 'Building Supply', 'Farms', 'Paper', 'Fasteners', 'Textiles', 'Brewing', 'Seafoods', 'Hardware', 'Plastics', 'Lumber', 'Appliances', 'Produce', 'Moving'];

export const CITIES = ['Denver', 'Toledo', 'Rotterdam', 'Austin', 'Leeds', 'Porto', 'Raleigh', 'Tacoma', 'Lyon', 'Krakow', 'Durban', 'Halifax', 'Tucson', 'Ghent', 'Bilbao', 'Wichita', 'Aarhus', 'Calgary', 'Turin', 'Dayton', 'Spokane', 'Utrecht', 'Boise', 'Malmo', 'Omaha', 'Valencia', 'Graz', 'Fresno', 'Tampere', 'Savannah'];

export const TEAM_TITLES = ['VP of sales', 'head of product', 'director of engineering', 'head of operations', 'VP of marketing', 'head of partnerships', 'director of finance', 'general counsel', 'head of customer success', 'VP of people'];
export const CONTACT_TITLES = ['director of operations', 'VP of supply chain', 'procurement manager', 'head of warehousing', 'logistics manager', 'IT director', 'operations manager', 'head of transport'];
export const VENDOR_TITLES = ['account executive', 'customer success manager', 'deal desk manager', 'solutions engineer', 'renewals manager', 'head of sales'];

export const FIELDS = ['economics', 'mechanical engineering', 'statistics', 'history', 'chemistry', 'supply chain management', 'computer science', 'philosophy', 'industrial design', 'accounting', 'linguistics', 'physics'];
export const SCHOOLS = ['Northgate University', 'the University of Calder', 'Westmarch Institute', 'Harrow Bay College', 'the Lenning School of Business', 'Ostmark Technical University', 'Saint Aldric College', 'the University of Varrow'];
export const HOBBIES = ['coaches a youth football team', 'restores old bicycles', 'sings in a community choir', 'runs trail races', 'keeps bees', 'plays chess online', 'bakes sourdough for the office', 'sails on weekends', 'collects vinyl records', 'volunteers at a food bank', 'climbs indoors twice a week', 'paints watercolors'];
export const EARLY_WORK = ['management consulting', 'a regional bank', 'retail operations', 'a shipping firm', 'public sector procurement', 'a hardware startup', 'a large carrier', 'an accounting firm', 'a grocery chain', 'a telecom operator'];

/** Person filler. Slots: {first}, {field}, {school}, {hobby}, {early}, {city}. */
export const PERSON_FILLER = [
  '{first} studied {field} at {school} before moving into industry.',
  '{first} grew up near {city} and still goes back for the long summer weekends.',
  'Colleagues describe {first} as patient in negotiations and quick with a spreadsheet.',
  '{first} prefers short written updates to long status meetings.',
  'Outside work, {first} {hobby}.',
  'Early on, {first} worked in {early}, which still shapes how deals get structured.',
  '{first} is usually the first to ask for the numbers behind a plan.',
  'In meetings {first} tends to listen first and summarize at the end.',
  '{first} has spoken at a few regional industry meetups about operations planning.',
  '{first} keeps a running list of open questions for every partner.',
  'People who work with {first} say the follow-up notes arrive the same afternoon.',
  '{first} likes to visit a site in person before agreeing to anything large.',
  'When a project slips, {first} asks for the smallest next step rather than a new plan.',
  '{first} mentors two junior colleagues and runs an informal reading group.',
  '{first} is direct about trade-offs and rarely promises dates without a buffer.',
  'A former colleague called {first} the calmest person in any escalation.',
  '{first} reads every customer complaint that mentions a missed delivery.',
  '{first} is careful with commitments and writes down what was agreed.',
  'Most weeks {first} blocks a morning for deep work and declines meetings then.',
  '{first} moved to {city} for work and stayed for the food scene.',
  '{first} tends to bring a printed agenda and to stick to it.',
  'Friends know {first} for long walks and longer opinions about coffee.',
  '{first} prefers phone calls to email when a decision is close.',
  '{first} took a sabbatical once to travel by train across several countries.',
];

/** Company filler. Slots: {name}, {industry}, {product}, {customer}, {city}. */
export const COMPANY_FILLER = [
  '{name} sells {product} to {customer}.',
  'Most of its customers are {customer}, and it sells to them through a small direct team.',
  'The engineering team works mostly out of {city}, with a few people remote.',
  '{name} has kept its headcount modest while it proves out the product.',
  'Its pitch to {customer} is simple: fewer manual steps and fewer surprises.',
  'Competitors in {industry} tend to target larger buyers, which leaves room for {name}.',
  'The company publishes a short product update every quarter.',
  '{name} runs pilots before every full rollout and converts most of them.',
  'Analysts who follow {industry} describe {name} as careful rather than flashy.',
  'Support is handled in-house, and response times are a point of pride.',
  'The product roadmap leans on feedback from a customer advisory group.',
  '{name} prices by site rather than by user, which buyers find easy to budget.',
  'The company hosts an annual customer day in {city}.',
  'Hiring has focused on field engineers who can work directly with {customer}.',
  'A partnership program lets resellers bundle {product} with their own services.',
];

/** Account filler. Slots: {name}, {city}, {business}. */
export const ACCOUNT_FILLER = [
  '{name} runs {business} out of {city}.',
  'The operations team is busiest in the autumn, when volumes peak.',
  'Their main complaint before rollout was paperwork that lived in three systems.',
  'Dock scheduling is the part of the product they use most.',
  'The site supervisors prefer the tablet view on the floor.',
  'They ask for a quarterly review and come prepared with their own numbers.',
  'Procurement runs a formal review before every contract change.',
  'Integration with their warehouse system was the long pole during onboarding.',
  'The relationship is friendly, but they negotiate hard on price.',
  'They have asked twice about an analytics add-on.',
  'Shift handoffs are where most of their support tickets start.',
  'Their finance team wants invoices to reference the purchase order number.',
];

export const ACCOUNT_BUSINESS: Readonly<Record<string, string>> = {
  'Cold Storage': 'refrigerated warehousing', Freight: 'a regional trucking operation', Distribution: 'a wholesale distribution business', Fulfillment: 'e-commerce fulfillment centers',
  Packaging: 'a packaging plant', Supply: 'an industrial supply business', Grocers: 'a chain of grocery stores', 'Building Supply': 'building supply yards', Farms: 'a cooperative of farms',
  Paper: 'a paper mill and converting plant', Fasteners: 'a fastener distribution business', Textiles: 'a textile mill', Brewing: 'a brewery with its own distribution', Seafoods: 'a seafood processing plant',
  Hardware: 'a hardware wholesale business', Plastics: 'a plastics molding plant', Lumber: 'lumber yards', Appliances: 'an appliance distribution business', Produce: 'a produce packing house', Moving: 'a moving and storage company',
};

/** Meeting discussion filler. Slots: {org}, {person}. */
export const MEETING_FILLER = [
  'Most of the time went to the rollout plan for the next quarter.',
  'We agreed to send a written summary by the end of the week.',
  '{person} asked for a clearer view of open support tickets.',
  'There was a long tangent about hiring field staff.',
  'The group reviewed last quarter\'s goals and marked most of them done.',
  'Action item: share the integration checklist before the next call.',
  'We spent a few minutes on the training schedule for new supervisors.',
  '{person} raised the reporting gap again; we promised a fix in the next release.',
  'Next steps are owned on our side and due before the next review.',
  'The tone was positive, with a couple of pointed questions about response times.',
  'We walked through the dashboard that {org} uses every morning.',
  'Everyone agreed the pilot results were good enough to keep going.',
  'A follow-up call will cover security questionnaires.',
  '{person} wants fewer manual exports at month end.',
];

/** Informal note filler. Slots: {author}. */
export const NOTE_FILLER = [
  'Jotting this down before I forget.',
  'None of this is confirmed; treat it as hallway talk.',
  'Mostly logistics for next week.',
  'Need to check the paperwork before repeating any of this to a customer.',
  'Will update the account plan once I have the documents in front of me.',
  'Quick recap from a busy afternoon.',
  '{author} to follow up on the open items.',
  'Reminder to myself to book the quarterly reviews early.',
  'The pipeline review ran long again.',
  'Coffee chat notes, not a formal record.',
  'Most of the afternoon went to onboarding questions from the new site leads.',
  'The renewals forecast still needs a second pass before it goes to finance.',
  'Two customers asked about the tablet view again; product knows.',
  'I owe the solutions team a list of open integration questions.',
  'Somebody should tidy the shared folder before the next quarter starts.',
  'The support queue was quiet, which never lasts long.',
  'Training dates for the warehouse supervisors are still not booked.',
  'A few of these came up over lunch, so the details may be fuzzy.',
  'Holding off on any customer email until the order file is checked.',
  'The team wants a shorter template for these recaps.',
  'Flagging these so they do not get lost between calls.',
  'Nothing here should go into the account plan without a source.',
  'Next week is busy with site visits, so follow-ups may slip.',
  'Remember to ask the deal desk where the latest signed copies live.',
  'Some of this is secondhand and could be out of date.',
];

/** Contract boilerplate. Slots: {vendor}, {account}. */
export const CONTRACT_FILLER = [
  'Capitalized terms not defined here have the meanings given in the agreement.',
  'This instrument is governed by the same law and venue as the agreement.',
  'Each party represents that the person signing is authorized to do so.',
  'This document may be signed in counterparts, each of which is an original.',
  'Notices under this document go to the addresses in the agreement.',
  'If this document conflicts with the agreement, this document controls for the terms it states.',
  'The executed copy is kept in the order file maintained by {vendor}.',
  '{account} confirmed the purchase order reference on the signature page.',
  'No other term of the agreement changes unless this document says so.',
  'Invoices issued under this document reference the original agreement.',
];

export const ANNOUNCEMENT_FILLER = [
  'Terms were not disclosed.',
  'Customers should see no change to their contracts or support.',
  'The teams will keep their current offices for now.',
  'Employees were told in an all-hands meeting the same morning.',
  'The announcement followed several months of discussions.',
  'Industry watchers had expected a move like this for some time.',
];
