/** Shapes of the messages the server sends. Mirrors backend/app/hub.py. */

export type Phase = "lobby" | "question" | "reveal" | "leaderboard" | "final";
export type Texts = { cs: string; en: string };
export type Scale = "world" | "continent" | "country" | "city";

export interface Answer {
  lat: number;
  lng: number;
  scale: Scale;
  caption: Texts;
}

interface CommonState {
  type: "state";
  phase: Phase;
  round_index: number;
  round_count: number;
  server_now: number;
  ends_at: number | null;
  closed: boolean;
  time_limit: number | null;
  title: Texts;
  subtitle: Texts;
  map_start: "world" | "europe" | "czechia";
  photo: string | null;
  player_count: number;
}

export interface LeaderRow {
  id: string;
  name: string;
  total: number;
  rank: number;
  prev_rank: number | null;
  round_points: number | null;
}

export interface HostState extends CommonState {
  role: "host";
  players: { id: string; name: string; connected: boolean }[];
  connected_count: number;
  answered_count: number;
  is_last_round: boolean;
  missing_location_count: number;
  answer: Answer | null;
  guesses: { name: string; lat: number; lng: number; distance_km: number; points: number }[] | null;
  leaderboard: LeaderRow[] | null;
}

export interface PlayerState extends CommonState {
  role: "player";
  me: { id: string; name: string; total: number; rank: number | null; prev_rank: number | null } | null;
  my_guess: { lat: number; lng: number } | null;
  answer: Answer | null;
  result: { distance_km: number; points: number } | null;
  podium: { name: string; total: number; rank: number }[] | null;
}

export interface AnonymousState extends CommonState {
  role: "anonymous";
}

export type ServerMessage =
  | HostState
  | PlayerState
  | AnonymousState
  | { type: "joined"; player_id: string; name: string }
  | { type: "error"; code: string }
  | { type: "kicked" }
  | { type: "reset" }
  | { type: "pong" };

export interface PhotoItem {
  id: string;
  lat: number | null;
  lng: number | null;
  caption_cs: string;
  caption_en: string;
  scale: Scale;
  time_limit: number | null;
  from_exif: boolean;
}

export interface QuizSettings {
  title_cs: string;
  title_en: string;
  subtitle_cs: string;
  subtitle_en: string;
  default_time_limit: number;
  map_start: "world" | "europe" | "czechia";
}
