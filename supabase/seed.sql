-- AICASA demo configuration and synthetic data.
-- EVERYTHING HERE IS SYNTHETIC. Routes, stages, SLA days, checklists and alert rules are illustrative
-- demo configuration and must be verified against the current Approval Process Handbook (APH) and
-- authorised guidance before any real use. Institutions and people are fictional.

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
insert into public.regions (code, name) values
  ('NR', 'Northern Region (demo)'), ('SR', 'Southern Region (demo)'), ('ER', 'Eastern Region (demo)'),
  ('WR', 'Western Region (demo)'), ('CR', 'Central Region (demo)')
on conflict (code) do nothing;

insert into public.system_settings (key, value, description) values
  ('display_timezone', '"Asia/Kolkata"', 'Timezone used to render dates and to interpret date-only deadlines (end of day).'),
  ('compliance.due_soon_days', '30', 'Obligations due within this many days are shown as Due soon.'),
  ('validity.expiring_soon_days', '90', 'Documents expiring within this many days are shown as Expiring soon.'),
  ('feature.university_access', '{"enabled": true}', 'Allow explicit university→college read grants.'),
  ('feature.ai_precheck', '{"enabled": false}', 'Optional AI explanation step in the document pre-check. Off unless a provider is configured.'),
  ('demo_mode', '{"enabled": true, "label": "Synthetic demonstration data — not AICTE records"}', 'Show demo labelling throughout the UI.')
on conflict (key) do nothing;

insert into public.integration_settings (code, name, status, notes) values
  ('email', 'Email delivery', 'unconfigured', 'No provider credentials. Notifications are in-app only; email attempts are logged as skipped.'),
  ('sms', 'SMS delivery', 'unconfigured', 'Not implemented for the prototype.'),
  ('ocr', 'OCR provider', 'unconfigured', 'Scanned images cannot be read; the pre-check marks them for manual review.'),
  ('ai', 'AI explanation provider', 'unconfigured', 'Deterministic checks only. No document content leaves the platform.'),
  ('aicte_portal', 'AICTE portal adapter', 'mock', 'No live connection. All applications are synthetic demo records.'),
  ('document_verification', 'Authorised document verification source', 'unconfigured', 'Authenticity cannot be verified; pre-check results never imply authenticity.')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Workflow routes (demo configuration)
-- ---------------------------------------------------------------------------
do $$
declare
  v_def uuid; v_ver uuid;
  v_src text := 'DEMO configuration for SIH26262 prototype — not verified against the current APH';
begin
  -- Route A: Scrutiny only
  insert into workflow_definitions (code, name, description)
  values ('ROUTE_SCRUTINY_ONLY', 'Scrutiny only', 'Document scrutiny followed by a recorded decision.') returning id into v_def;
  insert into workflow_definition_versions (definition_id, version, source_reference, change_summary)
  values (v_def, 1, v_src, 'Initial demo route') returning id into v_ver;
  insert into workflow_stages (version_id, code, name, kind, sequence, sla_days, responsible_capability) values
    (v_ver, 'intake', 'Intake', 'intake', 1, null, null),
    (v_ver, 'scrutiny', 'Scrutiny', 'scrutiny', 2, 21, 'scrutiny'),
    (v_ver, 'decision', 'Decision', 'decision', 3, 10, 'decision'),
    (v_ver, 'closed', 'Closed', 'terminal', 4, null, null);
  insert into workflow_transitions (version_id, code, name, from_stage, to_stage, allowed_role, required_capability,
                                    requires_reason, is_automatic, prerequisites, records_decision, sort_order) values
    (v_ver, 'intake_to_scrutiny', 'Begin scrutiny', 'intake', 'scrutiny', null, null, false, true, array['required_documents'], false, 1),
    (v_ver, 'scrutiny_to_decision', 'Forward for decision', 'scrutiny', 'decision', 'officer', 'scrutiny', false, false, array['no_open_deficiencies'], false, 1),
    (v_ver, 'record_decision', 'Record decision', 'decision', 'closed', 'officer', 'decision', true, false, array['no_open_deficiencies'], true, 1),
    (v_ver, 'refer_back_to_scrutiny', 'Refer back to scrutiny', 'decision', 'scrutiny', 'officer', 'decision', true, false, '{}', false, 2);

  -- Route B: Scrutiny with conditional EVC
  insert into workflow_definitions (code, name, description)
  values ('ROUTE_SCRUTINY_COND_EVC', 'Scrutiny + EVC (conditional)', 'Scrutiny; an expert visit is required only when an intake increase is declared.') returning id into v_def;
  insert into workflow_definition_versions (definition_id, version, source_reference, change_summary)
  values (v_def, 1, v_src, 'Initial demo route') returning id into v_ver;
  insert into workflow_stages (version_id, code, name, kind, sequence, sla_days, responsible_capability) values
    (v_ver, 'intake', 'Intake', 'intake', 1, null, null),
    (v_ver, 'scrutiny', 'Scrutiny', 'scrutiny', 2, 21, 'scrutiny'),
    (v_ver, 'evc', 'Expert Visit Committee (EVC)', 'evc', 3, 30, 'evc'),
    (v_ver, 'decision', 'Decision', 'decision', 4, 10, 'decision'),
    (v_ver, 'closed', 'Closed', 'terminal', 5, null, null);
  insert into workflow_transitions (version_id, code, name, from_stage, to_stage, allowed_role, required_capability,
                                    requires_reason, is_automatic, prerequisites, records_decision, sort_order) values
    (v_ver, 'intake_to_scrutiny', 'Begin scrutiny', 'intake', 'scrutiny', null, null, false, true, array['required_documents'], false, 1),
    (v_ver, 'scrutiny_to_evc', 'Route to EVC', 'scrutiny', 'evc', 'officer', 'scrutiny', false, false, array['no_open_deficiencies', 'form_flag:intake_increase'], false, 1),
    (v_ver, 'scrutiny_to_decision', 'Forward for decision', 'scrutiny', 'decision', 'officer', 'scrutiny', false, false, array['no_open_deficiencies', 'not_form_flag:intake_increase'], false, 2),
    (v_ver, 'evc_to_decision_auto', 'EVC satisfactory — forward for decision', 'evc', 'decision', null, null, false, true, array['evc_completed', 'evc_satisfactory', 'no_open_deficiencies'], false, 1),
    (v_ver, 'evc_to_decision', 'Forward for decision after EVC review', 'evc', 'decision', 'officer', 'evc', true, false, array['evc_completed', 'no_open_deficiencies'], false, 2),
    (v_ver, 'record_decision', 'Record decision', 'decision', 'closed', 'officer', 'decision', true, false, array['no_open_deficiencies'], true, 1),
    (v_ver, 'refer_back_to_scrutiny', 'Refer back to scrutiny', 'decision', 'scrutiny', 'officer', 'decision', true, false, '{}', false, 2);

  -- Route C: EVC + SAC/SHC
  insert into workflow_definitions (code, name, description)
  values ('ROUTE_EVC_COMMITTEE', 'EVC + SAC/SHC', 'Expert visit, committee review (SAC/SHC), then a recorded decision.') returning id into v_def;
  insert into workflow_definition_versions (definition_id, version, source_reference, change_summary)
  values (v_def, 1, v_src, 'Initial demo route') returning id into v_ver;
  insert into workflow_stages (version_id, code, name, kind, sequence, sla_days, responsible_capability) values
    (v_ver, 'intake', 'Intake', 'intake', 1, null, null),
    (v_ver, 'evc', 'Expert Visit Committee (EVC)', 'evc', 2, 30, 'evc'),
    (v_ver, 'committee', 'SAC/SHC committee', 'committee', 3, 15, 'committee'),
    (v_ver, 'decision', 'Decision', 'decision', 4, 10, 'decision'),
    (v_ver, 'closed', 'Closed', 'terminal', 5, null, null);
  insert into workflow_transitions (version_id, code, name, from_stage, to_stage, allowed_role, required_capability,
                                    requires_reason, is_automatic, prerequisites, records_decision, sort_order) values
    (v_ver, 'intake_to_evc', 'Queue for EVC', 'intake', 'evc', null, null, false, true, array['required_documents'], false, 1),
    (v_ver, 'evc_to_committee_auto', 'EVC satisfactory — forward to committee', 'evc', 'committee', null, null, false, true, array['evc_completed', 'evc_satisfactory', 'no_open_deficiencies'], false, 1),
    (v_ver, 'evc_to_committee', 'Forward to committee after EVC review', 'evc', 'committee', 'officer', 'evc', true, false, array['evc_completed', 'no_open_deficiencies'], false, 2),
    (v_ver, 'committee_to_decision', 'Record committee recommendation', 'committee', 'decision', 'officer', 'committee', true, false, array['no_open_deficiencies'], false, 1),
    (v_ver, 'committee_refer_evc', 'Refer back for fresh EVC', 'committee', 'evc', 'officer', 'committee', true, false, '{}', false, 2),
    (v_ver, 'record_decision', 'Record decision', 'decision', 'closed', 'officer', 'decision', true, false, array['no_open_deficiencies'], true, 1);

  -- Route D: EVC only
  insert into workflow_definitions (code, name, description)
  values ('ROUTE_EVC_ONLY', 'EVC only', 'Expert visit followed by a recorded decision.') returning id into v_def;
  insert into workflow_definition_versions (definition_id, version, source_reference, change_summary)
  values (v_def, 1, v_src, 'Initial demo route') returning id into v_ver;
  insert into workflow_stages (version_id, code, name, kind, sequence, sla_days, responsible_capability) values
    (v_ver, 'intake', 'Intake', 'intake', 1, null, null),
    (v_ver, 'evc', 'Expert Visit Committee (EVC)', 'evc', 2, 30, 'evc'),
    (v_ver, 'decision', 'Decision', 'decision', 3, 10, 'decision'),
    (v_ver, 'closed', 'Closed', 'terminal', 4, null, null);
  insert into workflow_transitions (version_id, code, name, from_stage, to_stage, allowed_role, required_capability,
                                    requires_reason, is_automatic, prerequisites, records_decision, sort_order) values
    (v_ver, 'intake_to_evc', 'Queue for EVC', 'intake', 'evc', null, null, false, true, array['required_documents'], false, 1),
    (v_ver, 'evc_to_decision_auto', 'EVC satisfactory — forward for decision', 'evc', 'decision', null, null, false, true, array['evc_completed', 'evc_satisfactory', 'no_open_deficiencies'], false, 1),
    (v_ver, 'evc_to_decision', 'Forward for decision after EVC review', 'evc', 'decision', 'officer', 'evc', true, false, array['evc_completed', 'no_open_deficiencies'], false, 2),
    (v_ver, 'record_decision', 'Record decision', 'decision', 'closed', 'officer', 'decision', true, false, array['no_open_deficiencies'], true, 1);

  -- Route E: Scrutiny with two concurrent reviews. Only this demo route is configured for parallel review;
  -- the other routes keep a single scrutiny officer.
  insert into workflow_definitions (code, name, description)
  values ('ROUTE_PARALLEL_SCRUTINY', 'Scrutiny with concurrent reviews', 'Two independent reviews run in parallel during scrutiny; routing waits for both.') returning id into v_def;
  insert into workflow_definition_versions (definition_id, version, source_reference, change_summary)
  values (v_def, 1, v_src, 'Initial demo route with concurrent reviews') returning id into v_ver;
  insert into workflow_stages (version_id, code, name, kind, sequence, sla_days, responsible_capability) values
    (v_ver, 'intake', 'Intake', 'intake', 1, null, null),
    (v_ver, 'scrutiny', 'Scrutiny', 'scrutiny', 2, 21, 'scrutiny'),
    (v_ver, 'decision', 'Decision', 'decision', 3, 10, 'decision'),
    (v_ver, 'closed', 'Closed', 'terminal', 4, null, null);
  insert into workflow_stage_reviews (version_id, stage_code, code, name, required_capability, description, sort_order) values
    (v_ver, 'scrutiny', 'land_building', 'Land and building documents review', 'scrutiny', 'Lease/ownership deed and building plan for the new site.', 1),
    (v_ver, 'scrutiny', 'safety_compliance', 'Safety and compliance record review', 'compliance', 'Fire safety certificate and the institution''s open compliance obligations.', 2);
  insert into workflow_transitions (version_id, code, name, from_stage, to_stage, allowed_role, required_capability,
                                    requires_reason, is_automatic, prerequisites, records_decision, sort_order) values
    (v_ver, 'intake_to_scrutiny', 'Begin scrutiny', 'intake', 'scrutiny', null, null, false, true, array['required_documents'], false, 1),
    (v_ver, 'scrutiny_to_decision', 'Forward for decision', 'scrutiny', 'decision', 'officer', 'scrutiny', false, false, array['no_open_deficiencies', 'review_tasks_complete'], false, 1),
    (v_ver, 'record_decision', 'Record decision', 'decision', 'closed', 'officer', 'decision', true, false, array['no_open_deficiencies'], true, 1),
    (v_ver, 'refer_back_to_scrutiny', 'Refer back to scrutiny', 'decision', 'scrutiny', 'officer', 'decision', true, false, '{}', false, 2);
end $$;

insert into public.application_types (code, name, description, workflow_definition_id, form_schema) values
  ('CHANGE_NAME', 'Change in name of institution', 'Request to record a change in the institution''s name (demo type).',
   (select id from workflow_definitions where code = 'ROUTE_SCRUTINY_ONLY'),
   '[{"key":"proposed_name","label":"Proposed name","type":"text","required":true,"help":"Name exactly as resolved by the governing body."},
     {"key":"resolution_date","label":"Governing body resolution date","type":"date","required":true}]'),
  ('EOA', 'Extension of approval', 'Continuation of approval for the next academic year (demo type).',
   (select id from workflow_definitions where code = 'ROUTE_SCRUTINY_COND_EVC'),
   '[{"key":"approved_intake","label":"Currently approved intake","type":"number","required":true},
     {"key":"intake_increase","label":"Seeking an increase in intake","type":"boolean","required":false,"help":"Declaring an increase routes the case through an expert visit (EVC)."},
     {"key":"proposed_intake","label":"Proposed intake (if increasing)","type":"number","required":false}]'),
  ('NEW_INST', 'Approval for a new institution', 'Establishment of a new technical institution (demo type).',
   (select id from workflow_definitions where code = 'ROUTE_EVC_COMMITTEE'),
   '[{"key":"proposed_programmes","label":"Proposed programmes","type":"text","required":true},
     {"key":"land_area_acres","label":"Land area (acres)","type":"number","required":true}]'),
  ('RESTORE_INTAKE', 'Restoration of intake', 'Restoration of a previously reduced intake (demo type).',
   (select id from workflow_definitions where code = 'ROUTE_EVC_ONLY'),
   '[{"key":"programme","label":"Programme","type":"text","required":true},
     {"key":"previous_intake","label":"Intake before reduction","type":"number","required":true}]'),
  ('CHANGE_SITE', 'Change of site', 'Shifting the institution to a new campus site (demo type, concurrent-review route).',
   (select id from workflow_definitions where code = 'ROUTE_PARALLEL_SCRUTINY'),
   '[{"key":"proposed_site_address","label":"Address of the proposed site","type":"text","required":true},
     {"key":"land_area_acres","label":"Land area of the new site (acres)","type":"number","required":false},
     {"key":"built_up_area_sqm","label":"Built-up instructional area at the new site (sqm)","type":"number","required":false}]')
on conflict (code) do nothing;

insert into public.document_requirements (application_type_code, checklist_version, doc_type, name, description, is_required,
                                          allowed_mime_types, max_bytes, expiry_tracked, required_fields) values
  ('CHANGE_NAME', 1, 'board_resolution', 'Governing body resolution', 'Resolution approving the change of name.', true,
     array['application/pdf'], 5242880, false, array['institution_name', 'date', 'signature']),
  ('CHANGE_NAME', 1, 'affidavit', 'Affidavit', 'Notarised affidavit on the change of name.', true,
     array['application/pdf'], 5242880, false, array['institution_name', 'date', 'notary']),
  ('EOA', 1, 'affidavit', 'Affidavit', 'Notarised affidavit for the academic year.', true,
     array['application/pdf'], 5242880, false, array['institution_name', 'academic_year', 'notary']),
  ('EOA', 1, 'fire_safety_certificate', 'Fire safety certificate', 'Current fire safety certificate for the campus buildings.', true,
     array['application/pdf', 'image/png', 'image/jpeg'], 5242880, true, array['institution_name', 'issue_date', 'expiry_date']),
  ('EOA', 1, 'faculty_list', 'Faculty list', 'List of faculty (optional for the demo checklist).', false,
     array['application/pdf', 'text/plain'], 5242880, false, array['institution_name']),
  ('NEW_INST', 1, 'land_lease_deed', 'Land lease/ownership deed', 'Registered lease or ownership document for the campus land.', true,
     array['application/pdf'], 10485760, true, array['institution_name', 'issue_date', 'expiry_date']),
  ('NEW_INST', 1, 'building_plan_approval', 'Building plan approval', 'Approved building plan from the competent local authority.', true,
     array['application/pdf', 'image/png', 'image/jpeg'], 10485760, false, array['institution_name', 'date']),
  ('NEW_INST', 1, 'affidavit', 'Affidavit', 'Notarised affidavit by the promoting body.', true,
     array['application/pdf'], 5242880, false, array['institution_name', 'notary']),
  ('NEW_INST', 1, 'bank_solvency_certificate', 'Bank solvency certificate', 'Solvency certificate issued by a bank.', true,
     array['application/pdf'], 5242880, false, array['institution_name', 'date']),
  ('RESTORE_INTAKE', 1, 'affidavit', 'Affidavit', 'Notarised affidavit for restoration.', true,
     array['application/pdf'], 5242880, false, array['institution_name', 'academic_year', 'notary']),
  ('RESTORE_INTAKE', 1, 'compliance_report', 'Compliance report', 'Report on compliance with earlier observations.', true,
     array['application/pdf', 'text/plain'], 5242880, false, array['institution_name', 'date']),
  ('CHANGE_SITE', 1, 'land_lease_deed', 'Land lease/ownership deed (new site)', 'Registered lease or ownership document for the new site.', true,
     array['application/pdf'], 10485760, true, array['institution_name', 'issue_date', 'expiry_date']),
  ('CHANGE_SITE', 1, 'building_plan_approval', 'Building plan approval (new site)', 'Approved building plan for the new site.', true,
     array['application/pdf', 'image/png', 'image/jpeg'], 10485760, false, array['institution_name', 'date']),
  ('CHANGE_SITE', 1, 'fire_safety_certificate', 'Fire safety certificate (new site)', 'Fire safety certificate for the buildings at the new site.', true,
     array['application/pdf', 'image/png', 'image/jpeg'], 5242880, true, array['institution_name', 'issue_date', 'expiry_date'])
on conflict do nothing;

insert into public.escalation_rules (code, version, rule_kind, entity_type, offset_hours, recipient, recipient_capability,
                                     channel, max_repeats, repeat_interval_hours, source_reference, change_summary) values
  ('STAGE_DUE_REMINDER', 1, 'reminder', 'application_stage', -72, 'assigned_officer', null, 'in_app', 1, null, 'Demo internal target', 'Initial demo rule'),
  ('STAGE_OVERDUE_ESCALATION', 1, 'escalation', 'application_stage', 0, 'regional_admin', null, 'in_app_and_email', 3, 72, 'Demo internal target', 'Initial demo rule'),
  ('DEFICIENCY_DUE_REMINDER', 1, 'reminder', 'deficiency', -72, 'institution', null, 'in_app_and_email', 1, null, 'Demo internal target', 'Initial demo rule'),
  ('DEFICIENCY_OVERDUE_ESCALATION', 1, 'escalation', 'deficiency', 24, 'assigned_officer', null, 'in_app', 2, 72, 'Demo internal target', 'Initial demo rule'),
  ('EVC_SCHEDULING_REMINDER', 1, 'reminder', 'evc_schedule', -48, 'capability_officers', 'evc', 'in_app', 1, null, 'Demo internal target', 'Initial demo rule'),
  ('EVC_OVERDUE_ESCALATION', 1, 'escalation', 'evc_schedule', 24, 'regional_admin', null, 'in_app_and_email', 3, 72, 'Demo internal target', 'Initial demo rule'),
  ('OBLIGATION_DUE_REMINDER', 1, 'reminder', 'obligation', -336, 'institution', null, 'in_app_and_email', 2, 168, 'Demo internal target', 'Initial demo rule'),
  ('OBLIGATION_OVERDUE_ESCALATION', 1, 'escalation', 'obligation', 0, 'regional_admin', null, 'in_app', 3, 168, 'Demo internal target', 'Initial demo rule'),
  ('VALIDITY_RENEWAL_REMINDER', 1, 'reminder', 'document_validity', -2160, 'institution', null, 'in_app_and_email', 1, null, 'Demo internal target', 'Initial demo rule'),
  ('VALIDITY_EXPIRED_ESCALATION', 1, 'escalation', 'document_validity', 0, 'capability_officers', 'compliance', 'in_app', 2, 168, 'Demo internal target', 'Initial demo rule')
on conflict do nothing;

insert into public.institutions (code, name, kind, region_code, state, city, district, programmes, address, contact_email, is_demo) values
  ('DEMO-WR-001', 'Nirmala Institute of Technology (Demo)', 'college', 'WR', 'Maharashtra', 'Pune', 'Pune', '{CSE,Mechanical,Civil}', 'Plot 14, Demo Road, Pune', 'office@nirmala.demo.test', true),
  ('DEMO-WR-002', 'Sahyadri College of Engineering (Demo)', 'college', 'WR', 'Maharashtra', 'Nashik', 'Nashik', '{CSE,Mechanical,Civil}', 'Survey 221, Demo Nagar, Nashik', 'office@sahyadri.demo.test', true),
  ('DEMO-WR-003', 'Deccan Technical University (Demo)', 'university', 'WR', 'Maharashtra', 'Aurangabad', 'Aurangabad', '{CSE,ECE,Pharmacy}', 'University Campus, Demo Marg', 'registrar@deccan.demo.test', true),
  ('DEMO-SR-001', 'Coromandel Institute of Management (Demo)', 'standalone_institution', 'SR', 'Tamil Nadu', 'Chennai', 'Chennai', '{Management}', '7 Demo Salai, Chennai', 'office@coromandel.demo.test', true)
on conflict (code) do nothing;

-- Demo experts (synthetic people). Across four regions and six specializations. Three of them demonstrate the automatic exclusions
-- for Sahyadri College (Nashik): same district (Anil Wagh), affiliated (Kavita Joshi), declared conflict (Rohan Deshmukh).
insert into public.experts (code, full_name, specializations, home_district, home_state, home_institution_id, home_institution_name, region_code, is_demo)
select v.code, v.full_name, v.specs, v.district, v.state, (select id from public.institutions where code = v.inst), v.inst_name, v.region, true
from (values
  ('DEMO-EXP-001', 'Dr. Anil Wagh (Demo)',          '{CSE,ECE}'::text[],        'Nashik',     'Maharashtra', null,          'Nashik Polytechnic (Demo)',        'WR'),
  ('DEMO-EXP-002', 'Prof. Kavita Joshi (Demo)',     '{Mechanical}'::text[],     'Satara',     'Maharashtra', 'DEMO-WR-002', null,                               'WR'),
  ('DEMO-EXP-003', 'Dr. Rohan Deshmukh (Demo)',     '{Civil}'::text[],          'Kolhapur',   'Maharashtra', null,          'Shivaji Technical Institute (Demo)', 'WR'),
  ('DEMO-EXP-004', 'Dr. Lakshmi Narayanan (Demo)',  '{CSE}'::text[],            'Coimbatore', 'Tamil Nadu',  null,          'Kongu Engineering Forum (Demo)',   'SR'),
  ('DEMO-EXP-005', 'Prof. Suresh Babu (Demo)',      '{Mechanical,Civil}'::text[], 'Madurai',   'Tamil Nadu',  null,          'Vaigai College of Technology (Demo)', 'SR'),
  ('DEMO-EXP-006', 'Dr. Meenal Kapoor (Demo)',      '{Pharmacy}'::text[],       'Jaipur',     'Rajasthan',   null,          'Aravali Pharmacy Institute (Demo)', 'NR'),
  ('DEMO-EXP-007', 'Dr. Farida Shaikh (Demo)',      '{CSE,Mechanical}'::text[], 'Nagpur',     'Maharashtra', null,          'Orange City Institute (Demo)',     'WR'),
  ('DEMO-EXP-008', 'Prof. Sudipta Banerjee (Demo)', '{Civil,Management}'::text[], 'Kolkata',   'West Bengal', null,          'Hooghly Management School (Demo)', 'ER')
) as v(code, full_name, specs, district, state, inst, inst_name, region)
on conflict (code) do nothing;

insert into public.expert_availability (expert_id, kind, starts_at, ends_at, note)
select e.id, 'available', date_trunc('day', now()), date_trunc('day', now()) + interval '60 days', 'General availability for visits (demo)'
from public.experts e where e.code in ('DEMO-EXP-004', 'DEMO-EXP-005', 'DEMO-EXP-007', 'DEMO-EXP-008')
  and not exists (select 1 from public.expert_availability a where a.expert_id = e.id);
insert into public.expert_availability (expert_id, kind, starts_at, ends_at, note)
select e.id, 'unavailable', date_trunc('day', now()) + interval '10 days', date_trunc('day', now()) + interval '24 days', 'Examination duty (demo)'
from public.experts e where e.code = 'DEMO-EXP-006'
  and not exists (select 1 from public.expert_availability a where a.expert_id = e.id);

insert into public.evc_conflict_declarations (expert_id, institution_id, nature)
select e.id, i.id, 'Co-author with a Sahyadri trustee on a 2024 research project (demo declaration).'
from public.experts e, public.institutions i where e.code = 'DEMO-EXP-003' and i.code = 'DEMO-WR-002'
on conflict do nothing;

insert into public.institution_access_grants (grantee_institution_id, target_institution_id, relationship, source_reference)
select u.id, c.id, 'affiliation', 'Demo affiliation record — read-only grant'
from institutions u, institutions c where u.code = 'DEMO-WR-003' and c.code = 'DEMO-WR-002'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Demo access. Auth users are created by scripts/provision-demo.mjs (Supabase Admin API, service role);
-- this function then grants their synthetic roles. There is no self-service role selection anywhere.
-- ---------------------------------------------------------------------------
create or replace function public.provision_demo_access() returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_spec jsonb := '[
    {"email":"inst.nirmala@aicasa-demo.test","name":"Priya Natarajan (Demo)","designation":"Principal","role":"institution","institution":"DEMO-WR-001"},
    {"email":"inst.sahyadri@aicasa-demo.test","name":"Vikram Patil (Demo)","designation":"Director","role":"institution","institution":"DEMO-WR-002"},
    {"email":"univ.deccan@aicasa-demo.test","name":"Dr. Sunita Rao (Demo)","designation":"Registrar","role":"institution","institution":"DEMO-WR-003"},
    {"email":"inst.coromandel@aicasa-demo.test","name":"Arun Iyer (Demo)","designation":"Secretary","role":"institution","institution":"DEMO-SR-001"},
    {"email":"officer.wr.scrutiny@aicasa-demo.test","name":"Anita Deshpande (Demo)","designation":"Scrutiny Officer, WR","role":"officer","region":"WR","caps":["scrutiny"]},
    {"email":"officer.wr.evc@aicasa-demo.test","name":"Rahul Kulkarni (Demo)","designation":"EVC Coordinator, WR","role":"officer","region":"WR","caps":["evc"]},
    {"email":"officer.wr.compliance@aicasa-demo.test","name":"Meera Joshi (Demo)","designation":"Compliance & Decision Officer, WR","role":"officer","region":"WR","caps":["compliance","decision","committee"]},
    {"email":"officer.sr@aicasa-demo.test","name":"Karthik Raman (Demo)","designation":"Regional Officer, SR","role":"officer","region":"SR","caps":["scrutiny","evc","committee","compliance","decision"]},
    {"email":"admin.national@aicasa-demo.test","name":"Neha Sharma (Demo)","designation":"National Administrator","role":"admin","region":null,"caps":["assignment","workflow_config","user_admin","reports","audit","escalation","compliance"]},
    {"email":"admin.wr@aicasa-demo.test","name":"Sanjay Mehta (Demo)","designation":"Regional Administrator, WR","role":"admin","region":"WR","caps":["assignment","user_admin","reports","audit","escalation","compliance"]}
  ]';
  v jsonb; v_uid uuid; v_n integer := 0; v_missing text[] := '{}';
begin
  if coalesce(auth.role(), '') <> 'service_role' and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'provision_demo_access may only be run by the provisioning script';
  end if;
  for v in select * from jsonb_array_elements(v_spec) loop
    select id into v_uid from profiles where email = v ->> 'email';
    if v_uid is null then v_missing := v_missing || (v ->> 'email'); continue; end if;
    update profiles set full_name = v ->> 'name', designation = v ->> 'designation', is_demo = true where id = v_uid;
    if not exists (select 1 from user_role_assignments where user_id = v_uid and is_active) then
      insert into user_role_assignments (user_id, role, region_code, capabilities)
      values (v_uid, (v ->> 'role')::app.app_role, v ->> 'region',
              coalesce(array(select jsonb_array_elements_text(v -> 'caps')), '{}'));
      v_n := v_n + 1;
    end if;
    if v ->> 'institution' is not null then
      insert into institution_memberships (user_id, institution_id, member_role)
      select v_uid, i.id, 'representative' from institutions i where i.code = v ->> 'institution'
      on conflict (user_id, institution_id) do nothing;
    end if;
  end loop;
  return jsonb_build_object('granted', v_n, 'missing_users', v_missing);
end $$;
revoke execute on function public.provision_demo_access() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Demo cases. Called once by scripts/provision-demo.mjs (service role) after demo users exist.
-- It impersonates each demo user and calls the real public functions, so every record passes the same
-- validation, permission and workflow rules as live use. Afterwards a few timestamps are moved into the
-- past so that ageing, overdue and escalation states can be demonstrated. Audit log rows keep their real time.
-- ---------------------------------------------------------------------------
create or replace function app.demo_as(p_email text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from public.profiles where email = p_email;
  if v is null then raise exception 'Demo user % has not been provisioned', p_email; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  return v;
end $$;

create or replace function app.demo_file(p_uploads jsonb, p_key text, p_institution_code text, p_size bigint, p_mime text)
returns text
language plpgsql as $$
declare v_path text := p_uploads ->> p_key; v_inst uuid;
begin
  if v_path is not null then return v_path; end if;
  -- No uploaded object supplied (local tests): register a metadata-only placeholder object.
  select id into v_inst from public.institutions where code = p_institution_code;
  v_path := v_inst::text || '/' || gen_random_uuid()::text || case p_mime when 'application/pdf' then '.pdf' when 'image/png' then '.png' else '.txt' end;
  insert into storage.objects (bucket_id, name, metadata)
  values ('institution-documents', v_path, jsonb_build_object('size', p_size, 'mimetype', p_mime));
  return v_path;
end $$;

create or replace function app.demo_doc(p_uploads jsonb, p_key text, p_inst_code text, p_app uuid, p_doc_type text,
                                        p_file text, p_reason text default null, p_mime text default 'application/pdf')
returns uuid
language plpgsql as $$
declare v_inst uuid; v_ver public.document_versions;
begin
  select id into v_inst from public.institutions where code = p_inst_code;
  v_ver := public.register_document_version(v_inst, p_app, p_doc_type, null,
             app.demo_file(p_uploads, p_key, p_inst_code, 2048, p_mime), p_file, null, p_reason);
  return v_ver.id;
end $$;

create or replace function app.demo_shift(p_app uuid, p_days integer) returns void
language plpgsql as $$
declare d interval := make_interval(days => p_days);
begin
  alter table public.application_events disable trigger application_events_append_only;
  alter table public.evc_history disable trigger evc_history_append_only;
  alter table public.deficiency_submissions disable trigger deficiency_submissions_append_only;
  alter table public.deficiency_reviews disable trigger deficiency_reviews_append_only;
  alter table public.application_decisions disable trigger decisions_append_only;
  alter table public.evc_reports disable trigger evc_reports_append_only;
  update public.evc_reports set uploaded_at = uploaded_at - d where evc_id in (select id from public.evc_records where application_id = p_app);
  alter table public.evc_reports enable trigger evc_reports_append_only;
  update public.applications set created_at = created_at - d, submitted_at = submitted_at - d, stage_entered_at = stage_entered_at - d,
    stage_due_at = stage_due_at - d, closed_at = closed_at - d, updated_at = updated_at - d where id = p_app;
  update public.application_events set created_at = created_at - d where application_id = p_app;
  update public.application_stage_history set entered_at = entered_at - d, exited_at = exited_at - d, due_at = due_at - d where application_id = p_app;
  update public.application_assignments set assigned_at = assigned_at - d, ended_at = ended_at - d where application_id = p_app;
  update public.deficiencies set raised_at = raised_at - d, resolved_at = resolved_at - d where application_id = p_app;
  update public.deficiency_submissions set submitted_at = submitted_at - d where deficiency_id in (select id from public.deficiencies where application_id = p_app);
  update public.deficiency_reviews set reviewed_at = reviewed_at - d where deficiency_id in (select id from public.deficiencies where application_id = p_app);
  update public.evc_records set ready_at = ready_at - d, schedule_due_at = schedule_due_at - d, created_at = created_at - d,
    completed_at = completed_at - d where application_id = p_app;
  update public.evc_history set created_at = created_at - d where evc_id in (select id from public.evc_records where application_id = p_app);
  update public.application_decisions set created_at = created_at - d where application_id = p_app;
  update public.tasks set created_at = created_at - d, due_at = due_at - d where application_id = p_app;
  update public.documents set created_at = created_at - d where application_id = p_app;
  update public.document_versions set uploaded_at = uploaded_at - d where document_id in (select id from public.documents where application_id = p_app);
  alter table public.application_events enable trigger application_events_append_only;
  alter table public.evc_history enable trigger evc_history_append_only;
  alter table public.deficiency_submissions enable trigger deficiency_submissions_append_only;
  alter table public.deficiency_reviews enable trigger deficiency_reviews_append_only;
  alter table public.application_decisions enable trigger decisions_append_only;
end $$;

-- Two cases whose declared figures breach Deficiency Matrix rules; submitting them records the deficiencies automatically.
create or replace function app.demo_matrix_cases(p_uploads jsonb default '{}'::jsonb) returns void
language plpgsql as $$
declare a public.applications; v_inst uuid; v_form jsonb;
begin
  v_form := '{"approved_intake": 480, "intake_increase": false, "programme_level": "ug_engg", "student_count": 480, "faculty_count": 24,
              "computer_count": 120, "library_book_count": 4800, "lab_count": 5,
              "faculty_professors": 3, "faculty_associate_professors": 5, "faculty_assistant_professors": 16}'::jsonb;
  if not exists (select 1 from public.applications where title = 'Extension of approval — computing capacity review (demo)') then
    select id into v_inst from public.institutions where code = 'DEMO-WR-002';
    perform app.demo_as('inst.sahyadri@aicasa-demo.test');
    a := public.create_application_draft(v_inst, 'EOA', 'Extension of approval — computing capacity review (demo)', '2027-28', v_form || '{"computer_count": 95}');
    perform app.demo_doc(p_uploads, 'M1_affidavit', 'DEMO-WR-002', a.id, 'affidavit', 'affidavit_computing_review.pdf');
    perform app.demo_doc(p_uploads, 'M1_fire', 'DEMO-WR-002', a.id, 'fire_safety_certificate', 'fire_certificate_computing_review.pdf');
    select * into a from public.applications where id = a.id;
    perform public.submit_application(a.id, a.row_version);
  end if;
  if not exists (select 1 from public.applications where title = 'Extension of approval — faculty cadre review (demo)') then
    select id into v_inst from public.institutions where code = 'DEMO-WR-001';
    perform app.demo_as('inst.nirmala@aicasa-demo.test');
    a := public.create_application_draft(v_inst, 'EOA', 'Extension of approval — faculty cadre review (demo)', '2027-28', v_form || '{"faculty_professors": 0}');
    perform app.demo_doc(p_uploads, 'M2_affidavit', 'DEMO-WR-001', a.id, 'affidavit', 'affidavit_cadre_review.pdf');
    perform app.demo_doc(p_uploads, 'M2_fire', 'DEMO-WR-001', a.id, 'fire_safety_certificate', 'fire_certificate_cadre_review.pdf');
    select * into a from public.applications where id = a.id;
    perform public.submit_application(a.id, a.row_version);
  end if;
end $$;
revoke execute on function app.demo_matrix_cases(jsonb) from public, anon, authenticated;
alter function app.demo_matrix_cases(jsonb) set search_path = public, app;

-- One case on the concurrent-review route. Also callable on its own for databases seeded before the route existed.
create or replace function app.demo_parallel_case(p_uploads jsonb default '{}'::jsonb) returns uuid
language plpgsql as $$
declare a public.applications; v_inst uuid;
begin
  select * into a from public.applications where title = 'Change of site — Sahyadri College to the Survey 310 campus';
  if a.id is not null then return a.id; end if;
  select id into v_inst from public.institutions where code = 'DEMO-WR-002';
  perform app.demo_as('inst.sahyadri@aicasa-demo.test');
  a := public.create_application_draft(v_inst, 'CHANGE_SITE', 'Change of site — Sahyadri College to the Survey 310 campus', '2027-28',
    '{"proposed_site_address": "Survey 310, Demo Nagar Phase II, Nashik", "land_area_acres": 3.4, "built_up_area_sqm": 4800}');
  perform app.demo_doc(p_uploads, 'P1_lease', 'DEMO-WR-002', a.id, 'land_lease_deed', 'new_site_lease_deed.pdf');
  perform app.demo_doc(p_uploads, 'P1_plan', 'DEMO-WR-002', a.id, 'building_plan_approval', 'new_site_building_plan.pdf');
  perform app.demo_doc(p_uploads, 'P1_fire', 'DEMO-WR-002', a.id, 'fire_safety_certificate', 'new_site_fire_certificate.pdf');
  select * into a from public.applications where id = a.id;
  a := public.submit_application(a.id, a.row_version);
  return a.id;
end $$;

create or replace function public.seed_demo_cases(p_uploads jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, app, storage as $$
declare
  a applications; r jsonb; d deficiencies; e evc_records; o compliance_obligations; v uuid; vv uuid;
  n2 uuid; n3 uuid; n4 uuid; s1 uuid; s2 uuid; s3 uuid; c1 uuid; c2 uuid; d1 uuid;
  i_n uuid; i_s uuid; i_c uuid; i_d uuid; wr_evc uuid; sr uuid; v_report_path text;
begin
  if coalesce(auth.role(), '') <> 'service_role' and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'seed_demo_cases may only be run by the provisioning script';
  end if;
  if exists (select 1 from applications where is_demo) then
    return jsonb_build_object('skipped', true, 'reason', 'Demo cases already exist');
  end if;
  select id into i_n from institutions where code = 'DEMO-WR-001';
  select id into i_s from institutions where code = 'DEMO-WR-002';
  select id into i_d from institutions where code = 'DEMO-WR-003';
  select id into i_c from institutions where code = 'DEMO-SR-001';

  -- Nirmala: a draft
  perform app.demo_as('inst.nirmala@aicasa-demo.test');
  perform create_application_draft(i_n, 'EOA', 'Extension of approval 2027-28 (draft)', '2027-28',
    '{"approved_intake": 240, "intake_increase": false}');

  -- Nirmala N2: EOA with intake increase, returned for correction
  a := create_application_draft(i_n, 'EOA', 'Extension of approval with intake increase 2027-28', '2027-28',
    '{"approved_intake": 180, "intake_increase": true, "proposed_intake": 240}');
  n2 := a.id;
  perform app.demo_doc(p_uploads, 'N2_affidavit', 'DEMO-WR-001', n2, 'affidavit', 'affidavit_eoa_2027-28.pdf');
  perform app.demo_doc(p_uploads, 'N2_fire', 'DEMO-WR-001', n2, 'fire_safety_certificate', 'fire_safety_certificate.pdf');
  select * into a from applications where id = n2;
  a := submit_application(n2, a.row_version);
  perform app.demo_as('officer.wr.scrutiny@aicasa-demo.test');
  perform add_observation(n2, 'document', 'Fire safety certificate does not show a validity period.', 'internal');
  perform raise_deficiency(n2, 'Fire safety certificate validity not stated',
    'The uploaded certificate has no validity/expiry date, so currency cannot be established.',
    'Demo checklist item EOA/fire_safety_certificate (illustrative)',
    'Upload a fire safety certificate that states its validity period, issued by the competent authority.',
    'fire_safety_certificate', now() + interval '6 days');
  select * into a from applications where id = n2;
  perform return_for_correction(n2, a.row_version, 'Deficiency recorded during scrutiny; correction requested from the institution.');

  -- Nirmala N3: change of name, full lifecycle to closure
  perform app.demo_as('inst.nirmala@aicasa-demo.test');
  a := create_application_draft(i_n, 'CHANGE_NAME', 'Change of name to Nirmala Institute of Technology and Research', '2026-27',
    '{"proposed_name": "Nirmala Institute of Technology and Research (Demo)", "resolution_date": "2026-05-14"}');
  n3 := a.id;
  perform app.demo_doc(p_uploads, 'N3_resolution', 'DEMO-WR-001', n3, 'board_resolution', 'governing_body_resolution.pdf');
  perform app.demo_doc(p_uploads, 'N3_affidavit', 'DEMO-WR-001', n3, 'affidavit', 'affidavit_change_of_name.pdf');
  select * into a from applications where id = n3;
  perform submit_application(n3, a.row_version);
  perform app.demo_as('officer.wr.scrutiny@aicasa-demo.test');
  select * into a from applications where id = n3;
  r := perform_transition(n3, 'scrutiny_to_decision', a.row_version, null);
  perform app.demo_as('officer.wr.compliance@aicasa-demo.test');
  select * into a from applications where id = n3;
  r := perform_transition(n3, 'record_decision', a.row_version,
    'Documents found in order during scrutiny; decision recorded by competent authority (demo).', '{"decision": "approved"}');

  -- Nirmala N4: EOA with intake increase, routed to EVC, scheduling overdue
  perform app.demo_as('inst.nirmala@aicasa-demo.test');
  a := create_application_draft(i_n, 'EOA', 'Extension of approval with additional division 2027-28', '2027-28',
    '{"approved_intake": 120, "intake_increase": true, "proposed_intake": 180}');
  n4 := a.id;
  perform app.demo_doc(p_uploads, 'N4_affidavit', 'DEMO-WR-001', n4, 'affidavit', 'affidavit_additional_division.pdf');
  perform app.demo_doc(p_uploads, 'N4_fire', 'DEMO-WR-001', n4, 'fire_safety_certificate', 'fire_noc_scan.png', null, 'image/png');
  select * into a from applications where id = n4;
  perform submit_application(n4, a.row_version);
  perform app.demo_as('officer.wr.scrutiny@aicasa-demo.test');
  select * into a from applications where id = n4;
  r := perform_transition(n4, 'scrutiny_to_evc', a.row_version, null);

  -- Sahyadri S1: deficiency corrected, awaiting officer review (previous file version kept)
  perform app.demo_as('inst.sahyadri@aicasa-demo.test');
  a := create_application_draft(i_s, 'EOA', 'Extension of approval 2027-28', '2027-28', '{"approved_intake": 300, "intake_increase": false}');
  s1 := a.id;
  perform app.demo_doc(p_uploads, 'S1_affidavit', 'DEMO-WR-002', s1, 'affidavit', 'affidavit_2027-28.pdf');
  perform app.demo_doc(p_uploads, 'S1_fire', 'DEMO-WR-002', s1, 'fire_safety_certificate', 'fire_certificate_2023.pdf');
  select * into a from applications where id = s1;
  perform submit_application(s1, a.row_version);
  perform app.demo_as('officer.wr.scrutiny@aicasa-demo.test');
  d := raise_deficiency(s1, 'Fire safety certificate expired',
    'The certificate on record expired before the date of submission.',
    'Demo checklist item EOA/fire_safety_certificate (illustrative)',
    'Upload the current, renewed fire safety certificate.', 'fire_safety_certificate', now() + interval '10 days');
  select * into a from applications where id = s1;
  perform return_for_correction(s1, a.row_version, 'Expired fire safety certificate; renewal evidence requested.');
  perform app.demo_as('inst.sahyadri@aicasa-demo.test');
  vv := app.demo_doc(p_uploads, 'S1_fire_v2', 'DEMO-WR-002', s1, 'fire_safety_certificate', 'fire_certificate_2026_renewed.pdf',
    'Renewed certificate issued after the earlier one expired');
  perform submit_deficiency_correction(d.id, 'Uploaded the renewed fire safety certificate valid until March 2029.', vv);

  -- Sahyadri S2: new institution, EVC scheduled (confirmed, upcoming)
  a := create_application_draft(i_s, 'NEW_INST', 'New institution — Sahyadri School of Architecture', '2027-28',
    '{"proposed_programmes": "B.Arch (demo)", "land_area_acres": 6}');
  s2 := a.id;
  perform app.demo_doc(p_uploads, 'S2_lease', 'DEMO-WR-002', s2, 'land_lease_deed', 'land_lease_deed.pdf');
  perform app.demo_doc(p_uploads, 'S2_plan', 'DEMO-WR-002', s2, 'building_plan_approval', 'building_plan_approval.pdf');
  perform app.demo_doc(p_uploads, 'S2_affidavit', 'DEMO-WR-002', s2, 'affidavit', 'affidavit_promoting_trust.pdf');
  perform app.demo_doc(p_uploads, 'S2_bank', 'DEMO-WR-002', s2, 'bank_solvency_certificate', 'bank_solvency.pdf');
  select * into a from applications where id = s2;
  perform submit_application(s2, a.row_version);
  wr_evc := app.demo_as('officer.wr.evc@aicasa-demo.test');
  select * into e from evc_records where application_id = s2 and status = 'awaiting_scheduling';
  r := schedule_evc(e.id, date_trunc('hour', now()) + interval '5 days 4 hours', date_trunc('hour', now()) + interval '5 days 7 hours',
    '{}', true, 'Online EVC; institution to keep the campus walkthrough video link ready.', e.row_version);

  -- Sahyadri S3: restoration of intake, EVC held yesterday, outcome pending
  perform app.demo_as('inst.sahyadri@aicasa-demo.test');
  a := create_application_draft(i_s, 'RESTORE_INTAKE', 'Restoration of intake — Mechanical Engineering', '2027-28',
    '{"programme": "B.E. Mechanical (demo)", "previous_intake": 120}');
  s3 := a.id;
  perform app.demo_doc(p_uploads, 'S3_affidavit', 'DEMO-WR-002', s3, 'affidavit', 'affidavit_restoration.pdf');
  perform app.demo_doc(p_uploads, 'S3_report', 'DEMO-WR-002', s3, 'compliance_report', 'compliance_report.pdf');
  select * into a from applications where id = s3;
  perform submit_application(s3, a.row_version);
  perform app.demo_as('officer.wr.evc@aicasa-demo.test');
  select * into e from evc_records where application_id = s3 and status = 'awaiting_scheduling';
  r := schedule_evc(e.id, date_trunc('hour', now()) + interval '1 day', date_trunc('hour', now()) + interval '1 day 3 hours',
    '{}', true, null, e.row_version);
  update evc_records set scheduled_start = scheduled_start - interval '2 days', scheduled_end = scheduled_end - interval '2 days'
  where application_id = s3 and status = 'scheduled';

  -- Coromandel C1: new institution; EVC done, now with the SAC/SHC committee
  sr := app.demo_as('inst.coromandel@aicasa-demo.test');
  a := create_application_draft(i_c, 'NEW_INST', 'New institution — Coromandel School of Business Analytics', '2027-28',
    '{"proposed_programmes": "MBA Business Analytics (demo)", "land_area_acres": 3}');
  c1 := a.id;
  perform app.demo_doc(p_uploads, 'C1_lease', 'DEMO-SR-001', c1, 'land_lease_deed', 'lease_deed.pdf');
  perform app.demo_doc(p_uploads, 'C1_plan', 'DEMO-SR-001', c1, 'building_plan_approval', 'building_plan.pdf');
  perform app.demo_doc(p_uploads, 'C1_affidavit', 'DEMO-SR-001', c1, 'affidavit', 'affidavit.pdf');
  perform app.demo_doc(p_uploads, 'C1_bank', 'DEMO-SR-001', c1, 'bank_solvency_certificate', 'solvency.pdf');
  select * into a from applications where id = c1;
  perform submit_application(c1, a.row_version);
  perform app.demo_as('officer.sr@aicasa-demo.test');
  select * into e from evc_records where application_id = c1 and status = 'awaiting_scheduling';
  r := schedule_evc(e.id, date_trunc('hour', now()) + interval '1 day', date_trunc('hour', now()) + interval '1 day 2 hours',
    '{}', true, null, e.row_version);
  update evc_records set scheduled_start = scheduled_start - interval '3 days', scheduled_end = scheduled_end - interval '3 days'
  where id = e.id;
  select * into e from evc_records where id = e.id;
  -- the panel's inspection report, geo-tagged at the (synthetic) campus, must be on file before the session can be completed
  v_report_path := e.id::text || '/' || gen_random_uuid()::text || '.pdf';
  insert into storage.objects (bucket_id, name, metadata)
  values ('evc-reports', v_report_path, jsonb_build_object('size', 48210, 'mimetype', 'application/pdf'));
  perform register_evc_report(e.id, v_report_path, 'EVC_inspection_report_coromandel.pdf', null, 13.082700, 80.270700, 'manual', null,
    'Synthetic demo report; coordinates are a placeholder in Chennai.');
  perform complete_evc(e.id, 'satisfactory', 'Panel reviewed facilities via live walkthrough; observations recorded as satisfactory (demo).', e.row_version);

  -- Coromandel C2: change of name under scrutiny (visible to Southern Region staff only)
  perform app.demo_as('inst.coromandel@aicasa-demo.test');
  a := create_application_draft(i_c, 'CHANGE_NAME', 'Change of name to Coromandel Institute of Management Studies', '2026-27',
    '{"proposed_name": "Coromandel Institute of Management Studies (Demo)", "resolution_date": "2026-07-02"}');
  c2 := a.id;
  perform app.demo_doc(p_uploads, 'C2_resolution', 'DEMO-SR-001', c2, 'board_resolution', 'resolution.pdf');
  perform app.demo_doc(p_uploads, 'C2_affidavit', 'DEMO-SR-001', c2, 'affidavit', 'affidavit.pdf');
  select * into a from applications where id = c2;
  perform submit_application(c2, a.row_version);

  -- Deccan University D1: its own application under scrutiny
  perform app.demo_as('univ.deccan@aicasa-demo.test');
  a := create_application_draft(i_d, 'EOA', 'Extension of approval — University Department of Technology', '2027-28',
    '{"approved_intake": 360, "intake_increase": false}');
  d1 := a.id;
  perform app.demo_doc(p_uploads, 'D1_affidavit', 'DEMO-WR-003', d1, 'affidavit', 'affidavit.pdf');
  perform app.demo_doc(p_uploads, 'D1_fire', 'DEMO-WR-003', d1, 'fire_safety_certificate', 'fire_certificate.pdf');
  select * into a from applications where id = d1;
  perform submit_application(d1, a.row_version);

  -- Compliance: Nirmala lease validity (expiring in 45 days), undertaking (overdue), verified periodic report
  perform app.demo_as('inst.nirmala@aicasa-demo.test');
  v := app.demo_doc(p_uploads, 'N_lease', 'DEMO-WR-001', null, 'land_lease_deed', 'campus_lease_deed_2016.pdf');
  perform record_document_validity(i_n, v, 'land_lease_deed', 'Campus land lease deed', (current_date - interval '10 years')::date,
    (current_date + 45), 'Registered lease deed (synthetic)');
  perform app.demo_as('officer.wr.compliance@aicasa-demo.test');
  o := create_obligation(i_n, n3, 'undertaking', 'Display revised name on all statutory disclosures',
    'Undertaking given with the change-of-name request: update the mandatory disclosure page and signage.',
    'Undertaking dated 14 May 2026 (synthetic)', 'Screenshot of updated disclosure page and photograph of signage',
    'Registrar, Nirmala Institute (demo)', current_date + 20);
  update compliance_obligations set due_at = now() - interval '5 days', created_at = now() - interval '40 days' where id = o.id;
  o := create_obligation(i_n, null, 'periodic_report', 'Annual faculty and student strength return',
    'Submit the annual return of sanctioned and actual faculty and student strength.',
    'Demo periodic reporting rule (illustrative)', 'Signed annual return (PDF)', 'Principal, Nirmala Institute (demo)',
    current_date + 10, 'P1Y');
  perform app.demo_as('inst.nirmala@aicasa-demo.test');
  v := app.demo_doc(p_uploads, 'N_annual_return', 'DEMO-WR-001', null, 'annual_return', 'annual_return_2026.pdf');
  perform submit_compliance_evidence(o.id, v, 'Annual return for 2026 attached.', null, o.row_version);
  perform app.demo_as('officer.wr.compliance@aicasa-demo.test');
  select * into o from compliance_obligations where id = o.id;
  perform verify_compliance(o.id, 'verified', 'Return checked against the configured reporting template (demo).', o.row_version);

  -- Sahyadri: expired fire certificate validity record and an undertaking awaiting verification
  perform app.demo_as('inst.sahyadri@aicasa-demo.test');
  v := app.demo_doc(p_uploads, 'S_fire_validity', 'DEMO-WR-002', null, 'fire_safety_certificate', 'hostel_fire_certificate.pdf');
  perform record_document_validity(i_s, v, 'fire_safety_certificate', 'Hostel block fire safety certificate',
    (current_date - 375), (current_date - 10), 'Fire safety certificate (synthetic)');
  perform app.demo_as('officer.wr.compliance@aicasa-demo.test');
  o := create_obligation(i_s, s1, 'condition', 'Submit occupancy certificate for new library block',
    'Condition attached during processing: occupancy certificate for the library block.',
    'Demo condition (illustrative)', 'Occupancy certificate from local authority', 'Principal, Sahyadri (demo)', current_date + 25);
  perform app.demo_as('inst.sahyadri@aicasa-demo.test');
  v := app.demo_doc(p_uploads, 'S_occupancy', 'DEMO-WR-002', null, 'occupancy_certificate', 'occupancy_certificate.pdf');
  perform submit_compliance_evidence(o.id, v, 'Occupancy certificate issued by the municipal corporation.', null, o.row_version);

  -- Coromandel: undertaking due soon
  perform app.demo_as('officer.sr@aicasa-demo.test');
  perform create_obligation(i_c, c1, 'undertaking', 'Appoint full-time director before commencement',
    'Undertaking to appoint a full-time director meeting qualification norms before the first academic session.',
    'Undertaking in affidavit (synthetic)', 'Appointment order and director''s qualification documents',
    'Secretary, Coromandel Trust (demo)', current_date + 12);

  -- Sahyadri: change of site on the concurrent-review route (both reviews pending)
  perform app.demo_parallel_case(p_uploads);

  -- Two cases that breach matrix rules (computers; faculty cadre)
  perform app.demo_matrix_cases(p_uploads);

  -- Spread cases in time so ageing, SLA and escalations are visible.
  perform app.demo_shift(n3, 70);
  perform app.demo_shift(n2, 25);
  perform app.demo_shift(n4, 33);
  perform app.demo_shift(s1, 18);
  perform app.demo_shift(s2, 26);
  perform app.demo_shift(s3, 40);
  perform app.demo_shift(c1, 45);
  perform app.demo_shift(c2, 6);
  perform app.demo_shift(d1, 12);
  -- the shift moves deficiency deadlines back too; keep them where the officer set them
  update deficiencies set due_at = now() + interval '6 days' where application_id = n2;
  update deficiencies set due_at = now() + interval '8 days' where application_id = s1;
  update evc_records set scheduled_start = date_trunc('hour', now()) + interval '5 days 4 hours',
                         scheduled_end = date_trunc('hour', now()) + interval '5 days 7 hours'
  where application_id = s2 and status = 'scheduled';
  update evc_records set scheduled_start = date_trunc('hour', now()) - interval '1 day',
                         scheduled_end = date_trunc('hour', now()) - interval '1 day' + interval '3 hours'
  where application_id = s3 and status = 'scheduled';

  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform app.complete_hero_demo_inputs();
  -- the one evaluation routine records every unmet rule as an open query (same routine the deployed backfill uses)
  perform app.sync_matrix_deficiencies(x.id) from (select id from applications order by id) x;
  -- the case officers send the Nirmala rule queries to the institution (same function as the deployed demo)
  perform app.demo_send_matrix_queries();
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  r := app.run_deadline_scan('manual');

  return jsonb_build_object('ok', true, 'applications', (select count(*) from applications), 'scan', r);
end $$;

revoke execute on function public.seed_demo_cases(jsonb) from public, anon, authenticated;
revoke execute on function app.demo_parallel_case(jsonb) from public, anon, authenticated;
alter function app.demo_parallel_case(jsonb) set search_path = public, app;
revoke execute on function app.demo_as(text), app.demo_file(jsonb, text, text, bigint, text),
  app.demo_doc(jsonb, text, text, uuid, text, text, text, text), app.demo_shift(uuid, integer) from public, anon, authenticated;
grant execute on function public.seed_demo_cases(jsonb), public.provision_demo_access() to service_role;
alter function app.demo_as(text) set search_path = public, app;
alter function app.demo_file(jsonb, text, text, bigint, text) set search_path = public, app, storage;
alter function app.demo_doc(jsonb, text, text, uuid, text, text, text, text) set search_path = public, app;
alter function app.demo_shift(uuid, integer) set search_path = public, app;

-- Handbook pre-screening configuration (same statements as migration 20261024000100)
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

-- Deficiency Matrix rules. The numeric thresholds are SYNTHETIC: chosen for the demonstration and not taken from
-- the AICTE Approval Process Handbook. Each rule states where it applies and its source; results are advisory.
update application_types
set form_schema = form_schema || '[
  {"key":"library_book_count","label":"Library books / volumes (total)","type":"number","required":false,"help":"Total books and volumes in the central library."},
  {"key":"lab_count","label":"Number of laboratories","type":"number","required":false},
  {"key":"faculty_professors","label":"Faculty: Professors","type":"number","required":false},
  {"key":"faculty_associate_professors","label":"Faculty: Associate Professors","type":"number","required":false},
  {"key":"faculty_assistant_professors","label":"Faculty: Assistant Professors","type":"number","required":false},
  {"key":"programme_level","label":"Programme level","type":"text","required":false,"help":"ug_engg, pg_engg or diploma. Used by programme-dependent rules."}
]'::jsonb
where code in ('EOA', 'NEW_INST') and not (form_schema @> '[{"key":"library_book_count"}]'::jsonb);

insert into public.compliance_rules (code, version, label, kind, applies_to, params, source_reference, is_synthetic, explanation) values
  ('land_area_min', 1, 'Declared land area', 'min', array['EOA', 'NEW_INST', 'CHANGE_SITE'],
   '{"field": "land_area_acres", "threshold": 2.5, "unit": "acres"}',
   'SYNTHETIC DEMO RULE - illustrative value for the prototype; not taken from the AICTE Approval Process Handbook', true, ''),
  ('built_up_min', 1, 'Declared built-up instructional area', 'min', array['EOA', 'NEW_INST', 'CHANGE_SITE'],
   '{"field": "built_up_area_sqm", "threshold": 4200, "unit": "sqm"}',
   'SYNTHETIC DEMO RULE - illustrative value for the prototype; not taken from the AICTE Approval Process Handbook', true, ''),
  ('student_faculty_ratio', 1, 'Student-to-faculty ratio (declared figures)', 'ratio_max', array['EOA', 'NEW_INST'],
   '{"numerator": "student_count", "denominator": "faculty_count", "level_field": "programme_level", "default_level": "ug_engg",
     "threshold_by_level": {"ug_engg": 20, "pg_engg": 15, "diploma": 25}}',
   'Ratios 1:20 (UG Engg), 1:15 (PG Engg), 1:25 (Diploma) as supplied by the project team from APH 2024-27; not verified against the handbook', true, ''),
  ('computers_required', 1, 'Computers for the sanctioned intake', 'required_count', array['EOA', 'NEW_INST'],
   '{"base_field": "student_count", "divisor": 4, "declared_field": "computer_count", "noun": "computers", "subject": "Sanctioned intake"}',
   'Existing 1:4 student-to-computer norm used by the prototype (required computers = ceil(students / 4)); not verified against the current APH', true, ''),
  ('library_books_min', 1, 'Library books for the sanctioned intake', 'required_count', array['EOA', 'NEW_INST'],
   '{"base_field": "student_count", "factor": 10, "declared_field": "library_book_count", "noun": "library books", "subject": "Sanctioned intake"}',
   'DEMO VALUE (10 books per student) until the real APH figure is entered; not an AICTE requirement', true, ''),
  ('labs_min', 1, 'Minimum laboratories for the programme', 'min', array['EOA', 'NEW_INST'],
   '{"field": "lab_count", "threshold": 4, "unit": "laboratories"}',
   'DEMO VALUE (4 laboratories) until the real APH figure is entered; not an AICTE requirement', true, ''),
  ('faculty_cadre_ratio', 1, 'Faculty cadre ratio', 'cadre_ratio', array['EOA'],
   '{"base_field": "approved_intake", "level_field": "programme_level", "default_level": "ug_engg",
     "divisor_by_level": {"ug_engg": 20, "pg_engg": 15, "diploma": 25}, "ratios": [1, 2, 6],
     "names": ["Professors", "Associate Professors", "Assistant Professors"],
     "fields": ["faculty_professors", "faculty_associate_professors", "faculty_assistant_professors"]}',
   'Faculty = intake / 20 split Professor : Associate : Assistant = 1 : 2 : 6 (plus 1 Principal) as supplied by the project team from APH 2024-27 (UG Engineering); not verified against the handbook. The intake is read from approved_intake, which only the EOA form has, so the rule applies to EOA only.', true, ''),
  ('proposed_intake_consistency', 1, 'Proposed intake exceeds approved intake', 'consistency_gt', array['EOA'],
   '{"field": "proposed_intake", "other": "approved_intake", "when_flag": "intake_increase"}',
   'Form consistency check (logical comparison of two declared values; no regulatory threshold involved)', false, '')
on conflict do nothing;

insert into public.system_settings (key, value, description) values
  ('deficiency.correction_period', '{"days": 7, "source_reference": "DEMO default correction period; not a statutory period"}',
   'Default correction period used when an officer records a deficiency without choosing a date. Officers can set another date.'),
  ('evc.assignment_policy', '{"block_declared_conflicts": true, "require_availability_window": false, "max_open_evcs_per_member": 3, "source_reference": "DEMO assignment policy - illustrative, not an AICTE rule"}',
   'EVC assignment checks: block declared conflicts, whether recorded availability is required, and a workload guide.')
on conflict (key) do nothing;

-- Keep fresh installations aligned with the deployed rule provenance.
update application_types set form_schema = form_schema ||
  '[{"key":"principal_count","label":"Number of Principals","type":"number","required":false}]'::jsonb
where code = 'EOA' and not form_schema @> '[{"key":"principal_count"}]'::jsonb;

-- Verified against APH 2024–27, Annexure 5, pp. 95–96 (PDF pages 111–112).
-- Government-hosted original: https://cdnbbsr.s3waas.gov.in/s35938b4d054136e5d59ada6ec9c295d7a/uploads/2025/03/2025031399.pdf
update compliance_rules set source_reference = 'AICTE Approval Process Handbook 2024–27 — Annexure 5, sections 5.1–5.3 (faculty/student ratios)', is_synthetic = false
where code = 'student_faculty_ratio' and params->'threshold_by_level' = '{"ug_engg":20,"pg_engg":15,"diploma":25}'::jsonb;
update compliance_rules set source_reference = 'AICTE Approval Process Handbook 2024–27 — Annexure 5.2, UG Engineering cadre ratio 1:2:6 plus Principal. Prototype uses declared approved intake and whole-person rounding; PG/Diploma cadre allocation is not verified.', is_synthetic = false
where code = 'faculty_cadre_ratio' and params->'ratios' = '[1,2,6]'::jsonb;
update compliance_rules set source_reference = 'Demonstration configuration', explanation = ''
where is_synthetic and code in ('land_area_min','built_up_min','labs_min','library_books_min','computers_required');

