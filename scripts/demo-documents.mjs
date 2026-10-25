// Synthetic demo document contents. Every file is stamped as synthetic. Some are deliberately
// incomplete so the pre-check has real, explainable findings to show.
const S = 'SYNTHETIC DEMO DOCUMENT - NOT A REAL RECORD';

export const DEMO_DOCUMENTS = [
  { key: 'N2_affidavit', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Nirmala Institute of Technology (Demo), Pune', 'Academic year 2027-28',
    'We undertake that the information furnished in the application is true.', 'Sworn before Notary Public, Pune on 12/08/2026', 'Signed: Principal'] },
  { key: 'N2_fire', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'FIRE SAFETY CERTIFICATE', 'Issued to: Nirmala Institute of Technology (Demo)', 'Date of issue: 05/01/2026', 'Building: Main academic block'] },
  { key: 'N3_resolution', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'RESOLUTION OF THE GOVERNING BODY', 'Nirmala Institute of Technology (Demo)', 'Dated 14/05/2026',
    'Resolved that the institution be renamed Nirmala Institute of Technology and Research.', 'Signed: Chairperson, Governing Body'] },
  { key: 'N3_affidavit', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'AFFIDAVIT - CHANGE OF NAME', 'Nirmala Institute of Technology (Demo)', 'Date: 20/05/2026', 'Notarised by Notary Public, Pune'] },
  { key: 'N4_affidavit', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Nirmala Institute of Technology (Demo)', 'Academic year 2027-28', 'Sworn before Notary Public, Pune'] },
  { key: 'N4_fire', inst: 'DEMO-WR-001', mime: 'image/png' },
  { key: 'S1_affidavit', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Sahyadri College of Engineering (Demo), Nashik', 'Academic year 2026-27', 'Sworn before Notary Public, Nashik'] },
  { key: 'S1_fire', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'FIRE SAFETY CERTIFICATE', 'Issued to Sahyadri College of Engineering (Demo)', 'Date of issue: 01/04/2023', 'Valid till 31/03/2026'] },
  { key: 'S1_fire_v2', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'FIRE SAFETY CERTIFICATE (RENEWED)', 'Issued to Sahyadri College of Engineering (Demo)', 'Date of issue: 02/10/2026', 'Valid till 31/03/2029'] },
  { key: 'S2_lease', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'LEASE DEED', 'Lessee: Sahyadri College of Engineering (Demo)', 'Date of issue: 10/01/2020', 'Lease period ending 09/01/2050'] },
  { key: 'S2_plan', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'BUILDING PLAN APPROVAL', 'Sahyadri College of Engineering (Demo)', 'Dated 15/06/2025'] },
  { key: 'S2_affidavit', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'AFFIDAVIT BY PROMOTING TRUST', 'Sahyadri College of Engineering (Demo)', 'Notarised, Nashik'] },
  { key: 'S2_bank', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'BANK SOLVENCY CERTIFICATE', 'Sahyadri College of Engineering (Demo)', 'Dated 01/08/2026'] },
  { key: 'S3_affidavit', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Sahyadri College of Engineering (Demo)', 'Academic year 2027-28', 'Sworn before Notary Public'] },
  { key: 'S3_report', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'COMPLIANCE REPORT', 'Sahyadri College of Engineering (Demo)', 'Date: 18/07/2026', 'Status of earlier observations: addressed.'] },
  { key: 'C1_lease', inst: 'DEMO-SR-001', mime: 'application/pdf', lines: [S, 'LEASE DEED', 'Lessee: Coromandel Institute of Management (Demo)', 'Date of issue: 03/02/2024', 'Valid until 02/02/2054'] },
  { key: 'C1_plan', inst: 'DEMO-SR-001', mime: 'application/pdf', lines: [S, 'BUILDING PLAN APPROVAL', 'Coromandel Institute of Management (Demo)', 'Dated 11/11/2025'] },
  { key: 'C1_affidavit', inst: 'DEMO-SR-001', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Coromandel Institute of Management (Demo)', 'Notarised, Chennai'] },
  { key: 'C1_bank', inst: 'DEMO-SR-001', mime: 'application/pdf', lines: [S, 'BANK SOLVENCY CERTIFICATE', 'Coromandel Institute of Management (Demo)', 'Dated 05/09/2026'] },
  { key: 'C2_resolution', inst: 'DEMO-SR-001', mime: 'application/pdf', lines: [S, 'RESOLUTION', 'Coromandel Institute of Management (Demo)', 'Dated 02/07/2026', 'Signed: Secretary'] },
  { key: 'C2_affidavit', inst: 'DEMO-SR-001', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Coromandel Institute of Management (Demo)', 'Date: 05/07/2026', 'Notarised, Chennai'] },
  { key: 'D1_affidavit', inst: 'DEMO-WR-003', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Deccan Technical University (Demo)', 'Academic year 2027-28', 'Sworn before Notary Public'] },
  { key: 'D1_fire', inst: 'DEMO-WR-003', mime: 'application/pdf', lines: [S, 'FIRE SAFETY CERTIFICATE', 'Issued to Deccan Technical University (Demo)', 'Date of issue: 12/12/2025', 'Valid till 11/12/2028'] },
  { key: 'N_lease', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'LEASE DEED - CAMPUS LAND', 'Lessee: Nirmala Institute of Technology (Demo)', 'Registered 2016'] },
  { key: 'N_annual_return', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'ANNUAL RETURN 2026', 'Nirmala Institute of Technology (Demo)', 'Faculty and student strength return'] },
  { key: 'S_fire_validity', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'FIRE SAFETY CERTIFICATE - HOSTEL', 'Sahyadri College of Engineering (Demo)', 'Valid till 13/10/2026'] },
  { key: 'S_occupancy', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'OCCUPANCY CERTIFICATE', 'Library block, Sahyadri College of Engineering (Demo)'] },
  { key: 'M1_affidavit', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Sahyadri College of Engineering (Demo), Nashik', 'Academic year 2027-28', 'Sworn before Notary Public, Nashik'] },
  { key: 'M1_fire', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'FIRE SAFETY CERTIFICATE', 'Issued to Sahyadri College of Engineering (Demo)', 'Date of issue: 02/04/2026', 'Valid till 01/04/2029'] },
  { key: 'M2_affidavit', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'AFFIDAVIT', 'Nirmala Institute of Technology (Demo), Pune', 'Academic year 2027-28', 'Sworn before Notary Public, Pune'] },
  { key: 'M2_fire', inst: 'DEMO-WR-001', mime: 'application/pdf', lines: [S, 'FIRE SAFETY CERTIFICATE', 'Issued to Nirmala Institute of Technology (Demo)', 'Date of issue: 11/05/2026', 'Valid till 10/05/2029'] },
  { key: 'P1_lease', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'LEASE DEED - NEW SITE', 'Lessee: Sahyadri College of Engineering (Demo)', 'Survey 310, Demo Nagar Phase II, Nashik', 'Date of issue: 14/03/2026', 'Lease period ending 13/03/2056'] },
  { key: 'P1_plan', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'BUILDING PLAN APPROVAL - NEW SITE', 'Sahyadri College of Engineering (Demo)', 'Survey 310 campus', 'Dated 02/06/2026'] },
  { key: 'P1_fire', inst: 'DEMO-WR-002', mime: 'application/pdf', lines: [S, 'FIRE SAFETY CERTIFICATE - NEW SITE', 'Issued to Sahyadri College of Engineering (Demo)', 'Date of issue: 20/08/2026', 'Valid till 19/08/2029'] },
];

// 1×1 grey PNG standing in for a scanned image (deliberately unreadable without OCR).
export const SCAN_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64'));
