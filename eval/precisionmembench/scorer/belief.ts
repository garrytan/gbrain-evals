export interface Belief {
  _id: string;
  user_id: string;
  agent_id: string | null;
  type: BeliefType;
  canonical_name: string;
  aliases: string[];
  content: string;
  why_it_matters: string;
  scope: string[];
  pinned: boolean;
  user_edited: boolean;
  superseded_by: string | null;
  resolved_at: Date | null;
  compaction_note?: string;
  created_at: Date;
  updated_at: Date;
  participants?: string[];
  relation_type?: string;
}

export type BeliefType =
  | "entity"
  | "relation"
  | "preference"
  | "open_question"
  | "decision";
