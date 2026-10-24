-- Handbook compliance pre-screening: optional institution-declared figures on the dossier form, plus the
-- criteria the screening compares them with. Thresholds are DEMO configuration (versioned in system_settings,
-- with a source reference) and must be checked against the current Approval Process Handbook (APH).

update application_types
set form_schema = form_schema || '[
  {"key":"land_area_acres","label":"Land area (acres)","type":"number","required":false,"help":"Declared land area in acres. Used by the handbook pre-screening."}
]'::jsonb
where code = 'EOA' and not (form_schema @> '[{"key":"land_area_acres"}]'::jsonb);

update application_types
set form_schema = form_schema || '[
  {"key":"built_up_area_sqm","label":"Built-up instructional area (sqm)","type":"number","required":false,"help":"Declared built-up area used for instruction."},
  {"key":"faculty_count","label":"Number of faculty","type":"number","required":false},
  {"key":"student_count","label":"Number of students (sanctioned intake in the institution)","type":"number","required":false},
  {"key":"computer_count","label":"Number of computers for students","type":"number","required":false}
]'::jsonb
where code in ('EOA', 'NEW_INST') and not (form_schema @> '[{"key":"built_up_area_sqm"}]'::jsonb);

insert into system_settings (key, value, description) values (
  'compliance.handbook_criteria',
  '{
    "source_reference": "DEMO thresholds - verify against the current Approval Process Handbook (APH) before any real use",
    "criteria": [
      {"code": "land_area", "label": "Land Area Requirement", "kind": "min", "field": "land_area_acres", "threshold": 2.5, "unit": "Acres"},
      {"code": "built_up", "label": "Built-up Instructional Area", "kind": "min", "field": "built_up_area_sqm", "threshold": 4200, "unit": "sqm"},
      {"code": "faculty_ratio", "label": "Faculty-to-Student Ratio", "kind": "ratio_max", "numerator": "student_count", "denominator": "faculty_count", "threshold": 20, "target": "1:20"},
      {"code": "computer_ratio", "label": "Student Computer Ratio", "kind": "ratio_max", "numerator": "student_count", "denominator": "computer_count", "threshold": 4, "target": "1:4"}
    ]
  }',
  'Criteria for the advisory handbook pre-screening shown to officers. Demo thresholds; not statutory.'
) on conflict (key) do nothing;
