export enum TimerDirection {
  UP = 'UP',
  DOWN = 'DOWN',
}

export interface Stage {
  id: string;
  name: string;
  startTime: number; // in seconds
  endTime: number;   // in seconds (relevant for UP, usually 0 for DOWN)
  direction: TimerDirection;
  movesInStage: number; // number of moves in this stage
  increment: number; // seconds added per move
}

export interface ClockConfig {
  id: string;
  name: string;
  player1Name: string;
  player2Name: string;
  whitePlayer: 1 | 2; // Which player is playing as White
  stages: Stage[];
}

export interface MoveRecord {
  player: 1 | 2;
  moveNumber: number;
  timeRemaining: number;
  timestamp: number;
  duration: number;
}

export type GameStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'FINISHED';

export interface PlayerState {
  time: number;
  moves: number;
  currentStageIndex: number;
  isFlagged: boolean;
}
