export const LANDING_CONTENT = {
  header: {
    title: 'E-GatePass',
    subtitle: 'EARIST Visitor Management',
    navLinks: [
      { label: 'How it works', href: '#how-it-works' },
      { label: 'What you need', href: '#what-you-need' },
      { label: 'Privacy', href: '#privacy' },
      { label: 'FAQ', href: '#faq' },
    ],
  },
  hero: {
    eyebrow: 'EARIST Visitor Access',
    title: 'E-GatePass',
    subtitle: 'Secure digital visitor registration and campus entry verification.',
    supportingText: 'Request your QR gate pass before arriving. No visitor account is required.',
  },
  process: {
    heading: 'How E-GatePass works',
    intro: 'Complete your request online, then present the QR code at the campus gate.',
    steps: [
      { title: 'Request pass', text: 'Enter your visitor details, purpose, and visit date.' },
      { title: 'Photo and ID', text: 'Add a clear visitor photo and a valid ID when required.' },
      { title: 'Receive QR', text: 'Your QR code is created for the scheduled visit.' },
      { title: 'Guard approval', text: 'After the entry scan, campus security verifies and approves entry.' },
      { title: 'Scan out', text: 'Scan the same QR code when leaving to complete the visit record.' },
    ],
  },
  needs: {
    heading: 'What you need',
    intro: 'Prepare these before requesting your visitor pass.',
    items: [
      { title: 'Visitor details', text: 'Your full name and contact number.' },
      { title: 'Visitor photo', text: 'A clear, current photo for identity checking.' },
      { title: 'Valid ID', text: 'A photo ID when required by campus policy.' },
      { title: 'Visit information', text: 'Your purpose and intended visit date.' },
    ],
  },
  verification: {
    heading: 'Why visitor verification is required',
    intro: 'A consistent verification process helps EARIST manage campus access responsibly.',
    points: [
      { title: 'Campus safety', text: 'Security personnel can confirm who is entering the campus.' },
      { title: 'Identity verification', text: 'The submitted photo and ID support an in-person check.' },
      { title: 'Controlled access', text: 'Entry and exit scans show whether a visit is active or complete.' },
      { title: 'Accurate records', text: 'Visit information supports daily operations and emergency roll calls.' },
    ],
  },
  privacy: {
    heading: 'Privacy and safety',
    intro: 'Personal information is collected only for visitor verification, campus access, and visit records.',
    points: [
      'Visitor photos and IDs are available only to authorized personnel.',
      'Images are handled according to the system retention policy.',
      'The registration form presents the full privacy notice before submission.',
    ],
    law: 'Data is handled in line with the Data Privacy Act of 2012 (Republic Act No. 10173).',
  },
  faq: {
    heading: 'Frequently asked questions',
    items: [
      { q: 'Do I need an account?', a: 'No. Visitors complete a short registration form without creating a username or password.' },
      { q: 'Does receiving a QR mean I am approved to enter?', a: 'No. The QR identifies your visit request. Campus security reviews your photo and ID after the entry scan before approving entry.' },
      { q: 'Why do you need my photo and ID?', a: 'They help security confirm that the person presenting the QR code matches the visitor request.' },
      { q: 'How long is my QR code valid?', a: 'It is valid on the selected visit date during the configured campus visiting hours.' },
      { q: 'What happens after I scan at the entrance?', a: 'Your request appears in the guard queue for identity verification and an entry decision.' },
      { q: 'Why must I scan when leaving?', a: 'The exit scan closes your visit and keeps the list of people currently inside the campus accurate.' },
      { q: 'What if the system is unavailable?', a: 'Follow the instructions of campus security. A manual visitor process may be used while service is restored.' },
    ],
  },
  finalCta: {
    heading: 'Planning a visit to EARIST?',
    text: 'Register in advance and receive your digital gate pass before arriving.',
  },
  footer: {
    officialName: 'Eulogio "Amang" Rodriguez Institute of Science and Technology',
    systemName: 'EARIST E-GatePass Capstone Visitor Management System',
    location: 'Nagtahan Street, Sampaloc, Manila, 1008 Metro Manila',
    website: { text: 'Official EARIST website', href: 'https://earist.edu.ph/' },
    privacy: 'Visitor information is handled in line with the Data Privacy Act of 2012 (RA 10173).',
    project: 'Capstone Project — Mary Joy Cagande, Joseph Habana, Mon Gerald Lanon, and Jeferson Tambis',
    adviser: 'Adviser: Dhani San Jose',
  },
};
