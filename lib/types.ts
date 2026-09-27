export type Status =
  | "scheduled"
  | "waiting"
  | "available"
  | "partial"
  | "delayed"
  | "cancelled";
export interface Session {
  id: string;
  year: number;
  round: number;
  event: string;
  country: string;
  location: string;
  code: string;
  name: string;
  starts_at: string;
  status: Status;
  artifact_path: string | null;
  version: string | null;
  updated_at: string | null;
}
export interface Driver {
  code: string;
  name: string;
  team: string;
  color: string;
  number: string;
  position: number | null;
}
export interface Lap {
  driver: string;
  number: number;
  time: number | null;
  sectors: (number | null)[];
  stint: number;
  compound: string;
  tyre_age: number | null;
  fresh: boolean;
  position: number | null;
  deleted: boolean;
  accurate: boolean;
  track_status: string;
  pit_in: number | null;
  pit_out: number | null;
  phase: string;
  clean: boolean;
}
export interface Trace {
  driver: string;
  phase: string;
  lap: number;
  lap_time: number;
  distance: number[];
  time: (number | null)[];
  speed: (number | null)[];
  throttle: (number | null)[];
  brake: (number | null)[];
  gear: (number | null)[];
  rpm: (number | null)[];
  x: (number | null)[];
  y: (number | null)[];
  reliable: boolean;
  reason: string | null;
}
export interface Weather {
  minute: number;
  air: number | null;
  track: number | null;
  humidity: number | null;
  pressure: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  rain: boolean;
}
export interface Analysis {
  schema_version: 1;
  session_id: string;
  generated_at: string;
  provenance: {
    source: string;
    fastf1_version: string;
    units: {
      time: string;
      distance: string;
      speed: string;
      temperature: string;
    };
  };
  drivers: Driver[];
  laps: Lap[];
  traces: Trace[];
  weather: Weather[];
  pit_stops: { driver: string; lap: number; duration: number }[];
  phases: string[];
  unavailable: string[];
}
