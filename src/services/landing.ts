import { supabase, isConfigured } from '@/lib/supabase';
import type { ApplicationStatus, StageKind } from '@/types/domain';

export interface LandingCase {
  reference: string; title: string; institution: string; status: ApplicationStatus; current_stage: string; next_action: string | null;
  stages: { code: string; name: string; kind: StageKind; sequence: number }[];
}
export interface LandingSnapshot {
  generated_at: string;
  totals: { applications: number; in_process: number; with_institution: number; past_target: number };
  cases: LandingCase[];
}

/** The seeded figures and real demo cases behind the landing preview (the same records the signed-in dashboards count). */
export async function getLandingSnapshot(): Promise<LandingSnapshot | null> {
  if (!isConfigured) return null;
  const { data, error } = await supabase.rpc('landing_snapshot');
  if (error) return null;
  return data as LandingSnapshot;
}
