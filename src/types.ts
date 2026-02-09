// Slot availability states parsed from HTML
export type SlotStatus = 'available' | 'reserved' | 'recurring' | 'window_closed';

// Station categories at MX3 Fitness
export type StationType = 'private_station' | 'open_gym' | 'cardio';

export interface Station {
  id: number;
  name: string;
  type: StationType;
  durationMinutes: number;
}

// Noe Valley station IDs — these don't change
export const STATIONS: Record<number, Station> = {
  140: { id: 140, name: 'Noe 1', type: 'private_station', durationMinutes: 60 },
  141: { id: 141, name: 'Noe 2', type: 'private_station', durationMinutes: 60 },
  142: { id: 142, name: 'Noe 3', type: 'private_station', durationMinutes: 60 },
  143: { id: 143, name: 'Noe 4', type: 'private_station', durationMinutes: 60 },
  144: { id: 144, name: 'Open Gym 1', type: 'open_gym', durationMinutes: 30 },
  145: { id: 145, name: 'Open Gym 2', type: 'open_gym', durationMinutes: 30 },
  146: { id: 146, name: 'Open Gym 3', type: 'open_gym', durationMinutes: 30 },
  150: { id: 150, name: 'Air Bike', type: 'cardio', durationMinutes: 30 },
  163: { id: 163, name: 'Air Rower', type: 'cardio', durationMinutes: 30 },
  164: { id: 164, name: 'Climber', type: 'cardio', durationMinutes: 30 },
  147: { id: 147, name: 'Peloton', type: 'cardio', durationMinutes: 30 },
  149: { id: 149, name: 'Tread Mill', type: 'cardio', durationMinutes: 30 },
};

// Station name → ID lookup (so Claude can use names, not IDs)
export const STATION_BY_NAME: Record<string, number> = Object.fromEntries(
  Object.values(STATIONS).map(s => [s.name.toLowerCase(), s.id])
);

export interface TimeSlot {
  stationId: number;
  stationName: string;
  stationType: StationType;
  date: string;    // YYYY-MM-DD
  time: string;    // h:mmam/pm
  status: SlotStatus;
}

// Discriminated union — prevents invalid states
export type BookingResult =
  | { success: true; message: string }
  | { success: false; error: BookingError; message: string };

export type BookingError =
  | 'no_credits'
  | 'duplicate'
  | 'concurrent'
  | 'invalid'
  | 'session_expired'
  | 'network_error';

export interface Reservation {
  stationId: number;
  stationName: string;
  date: string;
  time: string;
  cancelParams?: Record<string, string>;
}

export interface MX3ClientConfig {
  baseUrl: string;
  locationPath: string;
  credentials: { username: string; password: string };
}
