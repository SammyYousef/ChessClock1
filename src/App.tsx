import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  Settings, 
  Gavel, 
  Plus, 
  Trash2, 
  Save, 
  Download,
  Upload,
  ChevronRight,
  ChevronLeft,
  X,
  Check,
  Flag
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ClockConfig, 
  Stage, 
  TimerDirection, 
  GameStatus, 
  PlayerState, 
  MoveRecord 
} from './types';
import { auth, db } from './firebase';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  User
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  onSnapshot, 
  setDoc, 
  deleteDoc,
  serverTimestamp,
  getDocFromServer
} from 'firebase/firestore';
import { LogIn, LogOut, User as UserIcon, Cloud, CloudOff } from 'lucide-react';

const DEFAULT_CONFIGS: ClockConfig[] = [
  {
    id: 'tournament-standard',
    name: 'Tournament Standard',
    player1Name: 'Player 1',
    player2Name: 'Player 2',
    whitePlayer: 1,
    whitePosition: 'BOTTOM',
    flaggingStopsClock: true,
    stages: [
      {
        id: 's1',
        name: 'Stage 1',
        startTime: 5400, // 90 mins
        endTime: 0,
        direction: TimerDirection.DOWN,
        movesInStage: 40,
        increment: 30
      },
      {
        id: 's2',
        name: 'Stage 2',
        startTime: 1800, // 30 mins added
        endTime: 0,
        direction: TimerDirection.DOWN,
        movesInStage: 999,
        increment: 30
      }
    ]
  },
  {
    id: 'blitz-5-0',
    name: 'Blitz 5+0',
    player1Name: 'Player 1',
    player2Name: 'Player 2',
    whitePlayer: 1,
    whitePosition: 'BOTTOM',
    flaggingStopsClock: true,
    stages: [
      {
        id: 's1',
        name: 'Main',
        startTime: 300,
        endTime: 0,
        direction: TimerDirection.DOWN,
        movesInStage: 999,
        increment: 0
      }
    ]
  }
];

export default function App() {
  // Auth State
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // Configurations
  const [configs, setConfigs] = useState<ClockConfig[]>(() => {
    const saved = localStorage.getItem('chess-clock-configs');
    return saved ? JSON.parse(saved) : DEFAULT_CONFIGS;
  });
  const [activeConfigId, setActiveConfigId] = useState(configs[0].id);
  const activeConfigRaw = configs.find(c => c.id === activeConfigId) || configs[0];
  // Ensure legacy configs have required fields
  const activeConfig = React.useMemo<ClockConfig>(() => ({
    ...activeConfigRaw,
    player1Name: activeConfigRaw.player1Name || 'Player 1',
    player2Name: activeConfigRaw.player2Name || 'Player 2',
    whitePlayer: activeConfigRaw.whitePlayer || 1,
    flaggingStopsClock: activeConfigRaw.flaggingStopsClock !== undefined ? activeConfigRaw.flaggingStopsClock : true
  }), [activeConfigRaw]);

  // Game State
  const [status, setStatus] = useState<GameStatus>('IDLE');
  const [activePlayer, setActivePlayer] = useState<1 | 2 | null>(null);
  const [p1, setP1] = useState<PlayerState>({ time: 0, moves: 0, currentStageIndex: 0, isFlagged: false });
  const [p2, setP2] = useState<PlayerState>({ time: 0, moves: 0, currentStageIndex: 0, isFlagged: false });
  const [moveLog, setMoveLog] = useState<MoveRecord[]>([]);
  
  // UI State
  const [showConfig, setShowConfig] = useState(false);
  const [showArbitration, setShowArbitration] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ClockConfig | null>(null);
  const [originalEditingConfig, setOriginalEditingConfig] = useState<ClockConfig | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const lastTickRef = useRef<number>(0);

  // Initialize game from config
  const resetGame = useCallback(() => {
    const firstStage = activeConfig.stages[0];
    setP1({ time: firstStage.startTime, moves: 0, currentStageIndex: 0, isFlagged: false });
    setP2({ time: firstStage.startTime, moves: 0, currentStageIndex: 0, isFlagged: false });
    setActivePlayer(null);
    setStatus('IDLE');
    setMoveLog([]);
  }, [activeConfig]);

  useEffect(() => {
    if (status === 'IDLE') {
      resetGame();
    }
  }, [activeConfigId, resetGame, status]);

  // Timer Logic
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Sync with Firestore
  useEffect(() => {
    if (!user) return;

    const configsRef = collection(db, 'users', user.uid, 'configs');
    const unsubscribe = onSnapshot(configsRef, (snapshot) => {
      const remoteConfigs: ClockConfig[] = [];
      snapshot.forEach((doc) => {
        remoteConfigs.push(doc.data() as ClockConfig);
      });

      if (remoteConfigs.length > 0) {
        setConfigs(prev => {
          // Merge logic: remote takes precedence for same IDs
          const merged = [...prev];
          remoteConfigs.forEach(rc => {
            const idx = merged.findIndex(c => c.id === rc.id);
            if (idx >= 0) {
              merged[idx] = rc;
            } else {
              merged.push(rc);
            }
          });
          return merged;
        });
      }
    }, (error) => {
      console.error("Firestore Error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  // Test Connection
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    }
    testConnection();
  }, []);

  // Timer Logic
  useEffect(() => {
    if (status === 'RUNNING' && activePlayer) {
      lastTickRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const now = Date.now();
        const delta = (now - lastTickRef.current) / 1000;
        lastTickRef.current = now;

        const updatePlayer = (prev: PlayerState) => {
          const currentStage = activeConfig.stages[prev.currentStageIndex];
          let newTime = prev.time;
          
          if (currentStage.direction === TimerDirection.DOWN) {
            newTime = prev.time - delta;
          } else {
            newTime = prev.time + delta;
          }

          const isFlagged = currentStage.direction === TimerDirection.DOWN && newTime <= 0;
          
          if (isFlagged && activeConfig.flaggingStopsClock) {
            setStatus('FINISHED');
          }

          return { ...prev, time: newTime, isFlagged };
        };

        if (activePlayer === 1) setP1(updatePlayer);
        else setP2(updatePlayer);
      }, 100);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status, activePlayer, activeConfig.stages]);

  const secondsToHMS = (totalSeconds: number) => {
    const safeSeconds = isNaN(totalSeconds) ? 0 : totalSeconds;
    const h = Math.floor(safeSeconds / 3600);
    const m = Math.floor((safeSeconds % 3600) / 60);
    const s = Math.floor(safeSeconds % 60);
    return { h, m, s };
  };

  const hmsToSeconds = (h: number, m: number, s: number) => {
    const safeH = isNaN(h) ? 0 : h;
    const safeM = isNaN(m) ? 0 : m;
    const safeS = isNaN(s) ? 0 : s;
    return (safeH * 3600) + (safeM * 60) + safeS;
  };

  const getStageStartMove = (stages: Stage[], index: number) => {
    let start = 1;
    for (let i = 0; i < index; i++) {
      const moves = stages[i].movesInStage;
      start += isNaN(moves) ? 0 : moves;
    }
    return start;
  };

  const handlePlayerPress = (player: 1 | 2) => {
    if (status === 'FINISHED') return;
    
    // If game is idle, the first press starts the game AND counts as Move 1
    if (status === 'IDLE') {
      setStatus('RUNNING');
      setActivePlayer(player === 1 ? 2 : 1);
    } else {
      if (status !== 'RUNNING') return;
      if (activePlayer !== player) return;
      setActivePlayer(player === 1 ? 2 : 1);
    }

    const currentPlayerState = player === 1 ? p1 : p2;
    const currentStage = activeConfig.stages[currentPlayerState.currentStageIndex];
    
    // Record move
    const lastMoveTime = moveLog.length > 0 ? moveLog[moveLog.length - 1].timestamp : Date.now();
    const duration = (Date.now() - lastMoveTime) / 1000;
    
    const newRecord: MoveRecord = {
      player,
      moveNumber: currentPlayerState.moves + 1,
      timeRemaining: currentPlayerState.time + currentStage.increment,
      timestamp: Date.now(),
      duration
    };
    setMoveLog(prev => [...prev, newRecord]);

    // Update current player
    const updateCurrent = (prev: PlayerState) => {
      const nextMoves = prev.moves + 1;
      let nextStageIndex = prev.currentStageIndex;
      let nextTime = prev.time + currentStage.increment;

      // Check stage transition
      // movesInCurrentStage is 1-indexed relative to stage start
      const stageStartMove = getStageStartMove(activeConfig.stages, nextStageIndex);
      const movesCompletedInStage = nextMoves - (stageStartMove - 1);

      if (movesCompletedInStage === currentStage.movesInStage && nextStageIndex < activeConfig.stages.length - 1) {
        nextStageIndex++;
        const nextStage = activeConfig.stages[nextStageIndex];
        nextTime += nextStage.startTime;
      }

      return { ...prev, moves: nextMoves, currentStageIndex: nextStageIndex, time: nextTime };
    };

    if (player === 1) setP1(updateCurrent);
    else setP2(updateCurrent);
  };

  const formatTime = (seconds: number) => {
    const isNegative = seconds < 0;
    const absSeconds = Math.abs(isNaN(seconds) ? 0 : seconds);
    const h = Math.floor(absSeconds / 3600);
    const m = Math.floor((absSeconds % 3600) / 60);
    const s = Math.floor(absSeconds % 60);
    
    const hStr = h > 0 ? `${h}:` : '';
    const mStr = m < 10 && h > 0 ? `0${m}:` : `${m}:`;
    const sStr = s < 10 ? `0${s}` : `${s}`;
    
    return `${isNegative ? '-' : ''}${hStr}${mStr}${sStr}`;
  };

  const saveConfigs = async (newConfigs: ClockConfig[]) => {
    setConfigs(newConfigs);
    localStorage.setItem('chess-clock-configs', JSON.stringify(newConfigs));

    if (user) {
      try {
        // Find what changed or was added
        for (const config of newConfigs) {
          const configRef = doc(db, 'users', user.uid, 'configs', config.id);
          await setDoc(configRef, {
            ...config,
            updatedAt: new Date().toISOString()
          }, { merge: true });
        }
      } catch (error) {
        console.error("Error saving to cloud:", error);
      }
    }
  };

  const deleteConfig = async (configId: string) => {
    const next = configs.filter(conf => conf.id !== configId);
    saveConfigs(next);
    
    if (user) {
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'configs', configId));
      } catch (error) {
        console.error("Error deleting from cloud:", error);
      }
    }
    
    if (activeConfigId === configId) setActiveConfigId(next[0].id);
  };

  const resetAllConfigs = async () => {
    localStorage.removeItem('chess-clock-configs');
    
    if (user) {
      try {
        // Delete all current configs from Firestore
        for (const config of configs) {
          await deleteDoc(doc(db, 'users', user.uid, 'configs', config.id));
        }
        // Save defaults
        for (const config of DEFAULT_CONFIGS) {
          const configRef = doc(db, 'users', user.uid, 'configs', config.id);
          await setDoc(configRef, {
            ...config,
            updatedAt: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error("Error resetting cloud configs:", error);
      }
    }

    setConfigs(DEFAULT_CONFIGS);
    setActiveConfigId(DEFAULT_CONFIGS[0].id);
    setEditingConfig(null);
    setOriginalEditingConfig(null);
  };

  const exportConfigs = () => {
    const content = JSON.stringify(configs, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chess_clock_configs_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
  };

  const importConfigs = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string);
        if (Array.isArray(imported)) {
          // Basic validation
          const valid = imported.every(c => c.id && c.name && Array.isArray(c.stages));
          if (valid) {
            saveConfigs(imported);
            setActiveConfigId(imported[0].id);
          } else {
            console.error("Invalid configuration file format.");
          }
        }
      } catch (err) {
        console.error("Import error:", err);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const login = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login Error:", error);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout Error:", error);
    }
  };

  const exportMoveLog = () => {
    const content = moveLog.map(m => 
      `Player ${m.player}, Move ${m.moveNumber}: ${m.duration.toFixed(2)}s (Remaining: ${formatTime(m.timeRemaining)})`
    ).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chess_game_log_${new Date().toISOString()}.txt`;
    a.click();
  };

  const [showHistory, setShowHistory] = useState(false);
  const [configToDelete, setConfigToDelete] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-emerald-500/30 flex flex-col items-center justify-center p-4 overflow-y-auto">
        <div className="w-full max-w-5xl flex flex-col gap-6 py-8">
          <div className="flex flex-col items-center gap-1 mb-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tighter text-white flex items-center gap-3">
              CHESS CLOCK
              <span className="bg-emerald-500 text-black px-2 py-0.5 rounded text-lg font-black italic">1</span>
            </h1>
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.3em]">by Sammy Yousef</p>
          </div>
          {/* Physical Casing Simulation */}
          <div className="relative w-full aspect-auto sm:aspect-[16/10] lg:aspect-[16/9] min-h-[500px] flex flex-col p-4 sm:p-8 rounded-[32px] sm:rounded-[40px] shadow-[0_50px_100px_-20px_rgba(0,0,0,0.7),0_30px_60px_-30px_rgba(0,0,0,0.8)] border-t border-white/10 overflow-hidden">
        {/* Wood Texture Background */}
        <div 
          className="absolute inset-0 z-0 opacity-40 mix-blend-overlay"
          style={{ 
            backgroundImage: 'url(https://images.unsplash.com/photo-1588345921523-c2d6c5f10f21?auto=format&fit=crop&w=1920&q=80)',
            backgroundSize: 'cover'
          }}
        />
        <div className="absolute inset-0 z-0 bg-gradient-to-br from-zinc-800 via-zinc-900 to-black opacity-90" />
        
        {/* Top Plungers (Decorative) */}
        <div className="absolute -top-6 left-0 right-0 flex justify-around px-10 sm:px-20 z-10 pointer-events-none">
          <div className={`w-20 sm:w-32 h-12 bg-zinc-800 rounded-t-2xl border-x border-t border-white/10 shadow-lg transition-transform duration-300 ${activePlayer === 1 ? 'translate-y-4' : 'translate-y-0'}`} />
          <div className={`w-20 sm:w-32 h-12 bg-zinc-800 rounded-t-2xl border-x border-t border-white/10 shadow-lg transition-transform duration-300 ${activePlayer === 2 ? 'translate-y-4' : 'translate-y-0'}`} />
        </div>

        <div className="relative z-20 flex-1 flex flex-col">
          {/* Main Clock Display Area */}
          <div className="flex-1 flex flex-col gap-4">
            {(() => {
              const whiteAtTop = activeConfig.whitePosition === 'TOP';
              const p1IsWhite = activeConfig.whitePlayer === 1;
              
              // Determine which player is rendered at the top
              // If whiteAtTop is true, the white player should be at the top.
              // If p1IsWhite is true, Player 1 is white.
              // So if (whiteAtTop && p1IsWhite) || (!whiteAtTop && !p1IsWhite), Player 1 is at the top.
              const p1AtTop = (whiteAtTop && p1IsWhite) || (!whiteAtTop && !p1IsWhite);
              
              const topPlayer = p1AtTop ? 1 : 2;
              const bottomPlayer = p1AtTop ? 2 : 1;
              const topState = p1AtTop ? p1 : p2;
              const bottomState = p1AtTop ? p2 : p1;
              const topName = p1AtTop ? activeConfig.player1Name : activeConfig.player2Name;
              const bottomName = p1AtTop ? activeConfig.player2Name : activeConfig.player1Name;
              const topColor = p1AtTop ? (activeConfig.whitePlayer === 1 ? 'WHITE' : 'BLACK') : (activeConfig.whitePlayer === 2 ? 'WHITE' : 'BLACK');
              const bottomColor = p1AtTop ? (activeConfig.whitePlayer === 2 ? 'WHITE' : 'BLACK') : (activeConfig.whitePlayer === 1 ? 'WHITE' : 'BLACK');

              return (
                <>
                  {/* Top Player */}
                  <div className="flex-1 flex flex-col gap-4">
                    <button
                      onClick={() => handlePlayerPress(topPlayer as 1 | 2)}
                      disabled={status === 'FINISHED' || (status === 'RUNNING' && activePlayer !== topPlayer)}
                      className={`flex-1 rounded-[32px] transition-all duration-500 flex flex-col items-center justify-center relative overflow-hidden border-4 ${
                        activePlayer === topPlayer 
                          ? topState.isFlagged ? 'bg-red-900/40 border-red-500 shadow-[inset_0_0_60px_rgba(239,68,68,0.3),0_0_40px_rgba(239,68,68,0.2)]' : 'bg-emerald-900/40 border-emerald-400 shadow-[inset_0_0_60px_rgba(16,185,129,0.3),0_0_40px_rgba(16,185,129,0.2)]' 
                          : topState.isFlagged ? 'bg-red-950/20 border-red-900/50 opacity-60' : 'bg-black/40 border-zinc-800/50 opacity-60'
                      } group`}
                    >
                      <div className="absolute inset-2 rounded-[24px] border border-white/5 pointer-events-none" />
                      <div className="absolute top-4 sm:top-6 left-4 sm:left-8 flex flex-wrap items-center gap-2 sm:gap-3">
                        <span className="text-zinc-400 font-bold text-base sm:text-xl tracking-tight">{topName}</span>
                        <span className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded-full text-[8px] sm:text-[10px] font-black uppercase tracking-widest ${topColor === 'WHITE' ? 'bg-white text-black' : 'bg-zinc-800 text-white border border-white/10'}`}>
                          {topColor}
                        </span>
                        {topState.isFlagged && (
                          <div className="flex items-center gap-1 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full bg-red-600 text-white text-[8px] sm:text-[10px] font-black uppercase tracking-widest animate-pulse shadow-lg shadow-red-900/40">
                            <Flag size={10} fill="currentColor" className="sm:w-3 sm:h-3" /> FLAGGED
                          </div>
                        )}
                      </div>
                      <div className={`text-6xl xs:text-7xl sm:text-8xl md:text-9xl font-mono font-bold tracking-tighter transition-colors duration-500 ${topState.isFlagged ? 'text-red-400' : activePlayer === topPlayer ? 'text-white' : 'text-zinc-600'}`}>
                        {formatTime(topState.time)}
                      </div>
                      <div className="mt-6 flex items-center gap-8">
                        <div className="text-sm text-zinc-500 font-bold uppercase tracking-widest">
                          Moves <span className="text-zinc-300 ml-2">{topState.moves}</span>
                        </div>
                        {topState.isFlagged && (
                          <div className="text-red-500 animate-bounce">
                            <Flag size={32} fill="currentColor" />
                          </div>
                        )}
                      </div>
                    </button>
                  </div>

                  {/* Center Controls */}
                  <div className="py-4 sm:py-6 flex flex-wrap items-center justify-between gap-4 sm:gap-6">
                    <div className="flex gap-2 sm:gap-3">
                      <button 
                        onClick={() => setShowConfig(true)}
                        className="p-3 sm:p-5 rounded-xl sm:rounded-2xl bg-zinc-800/50 hover:bg-zinc-700/50 border border-white/5 transition-all text-zinc-400 hover:text-white active:scale-95"
                        title="Configuration"
                      >
                        <Settings size={20} className="sm:w-6 sm:h-6" />
                      </button>
                      <button 
                        onClick={() => setShowArbitration(true)}
                        disabled={status !== 'PAUSED'}
                        className={`p-3 sm:p-5 rounded-xl sm:rounded-2xl border transition-all active:scale-95 ${status === 'PAUSED' ? 'bg-zinc-800/50 border-amber-500/30 hover:bg-zinc-700/50 text-amber-400' : 'bg-zinc-900/30 border-white/5 text-zinc-700 cursor-not-allowed'}`}
                        title="Arbitration"
                      >
                        <Gavel size={20} className="sm:w-6 sm:h-6" />
                      </button>
                    </div>

                    <div className="flex items-center gap-3 sm:gap-6">
                      <button
                        onClick={() => {
                          if (status === 'IDLE') {
                            setStatus('RUNNING');
                            setActivePlayer(activeConfig.whitePlayer);
                          } else {
                            setStatus(status === 'RUNNING' ? 'PAUSED' : 'RUNNING');
                          }
                        }}
                        disabled={status === 'FINISHED'}
                        className={`h-12 sm:h-16 px-6 sm:px-12 rounded-xl sm:rounded-2xl font-black text-sm sm:text-xl tracking-widest flex items-center gap-2 sm:gap-3 transition-all active:scale-95 shadow-xl ${
                          status === 'RUNNING' 
                            ? 'bg-amber-500 hover:bg-amber-400 text-black shadow-amber-900/20' 
                            : 'bg-emerald-500 hover:bg-emerald-400 text-black shadow-emerald-900/20'
                        } disabled:opacity-30 disabled:cursor-not-allowed`}
                      >
                        {status === 'RUNNING' ? <><Pause size={20} className="sm:w-6 sm:h-6" fill="currentColor" /> PAUSE</> : <><Play size={20} className="sm:w-6 sm:h-6" fill="currentColor" /> START</>}
                      </button>
                      
                      <button
                        onClick={resetGame}
                        className="p-3 sm:p-5 rounded-xl sm:rounded-2xl bg-zinc-800/50 hover:bg-zinc-700/50 border border-white/5 transition-all text-zinc-400 hover:text-white active:scale-95"
                        title="Reset"
                      >
                        <RotateCcw size={20} className="sm:w-6 sm:h-6" />
                      </button>
                    </div>

                    <div className="flex gap-2 sm:gap-3">
                      <button 
                        onClick={() => setShowHistory(true)}
                        disabled={moveLog.length === 0}
                        className="p-3 sm:p-5 rounded-xl sm:rounded-2xl bg-zinc-800/50 hover:bg-zinc-700/50 border border-white/5 transition-all text-zinc-400 hover:text-white active:scale-95 disabled:opacity-30"
                        title="View History"
                      >
                        <Download size={20} className="sm:w-6 sm:h-6" />
                      </button>
                    </div>
                  </div>

                  {/* Bottom Player */}
                  <div className="flex-1 flex flex-col gap-4">
                    <button
                      onClick={() => handlePlayerPress(bottomPlayer as 1 | 2)}
                      disabled={status === 'FINISHED' || (status === 'RUNNING' && activePlayer !== bottomPlayer)}
                      className={`flex-1 rounded-[32px] transition-all duration-500 flex flex-col items-center justify-center relative overflow-hidden border-4 ${
                        activePlayer === bottomPlayer 
                          ? bottomState.isFlagged ? 'bg-red-900/40 border-red-500 shadow-[inset_0_0_60px_rgba(239,68,68,0.3),0_0_40px_rgba(239,68,68,0.2)]' : 'bg-emerald-900/40 border-emerald-400 shadow-[inset_0_0_60px_rgba(16,185,129,0.3),0_0_40px_rgba(16,185,129,0.2)]' 
                          : bottomState.isFlagged ? 'bg-red-950/20 border-red-900/50 opacity-60' : 'bg-black/40 border-zinc-800/50 opacity-60'
                      } group`}
                    >
                      <div className="absolute inset-2 rounded-[24px] border border-white/5 pointer-events-none" />
                      <div className="absolute top-4 sm:top-6 left-4 sm:left-8 flex flex-wrap items-center gap-2 sm:gap-3">
                        <span className="text-zinc-400 font-bold text-base sm:text-xl tracking-tight">{bottomName}</span>
                        <span className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded-full text-[8px] sm:text-[10px] font-black uppercase tracking-widest ${bottomColor === 'WHITE' ? 'bg-white text-black' : 'bg-zinc-800 text-white border border-white/10'}`}>
                          {bottomColor}
                        </span>
                        {bottomState.isFlagged && (
                          <div className="flex items-center gap-1 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full bg-red-600 text-white text-[8px] sm:text-[10px] font-black uppercase tracking-widest animate-pulse shadow-lg shadow-red-900/40">
                            <Flag size={10} fill="currentColor" className="sm:w-3 sm:h-3" /> FLAGGED
                          </div>
                        )}
                      </div>
                      <div className={`text-6xl xs:text-7xl sm:text-8xl md:text-9xl font-mono font-bold tracking-tighter transition-colors duration-500 ${bottomState.isFlagged ? 'text-red-400' : activePlayer === bottomPlayer ? 'text-white' : 'text-zinc-600'}`}>
                        {formatTime(bottomState.time)}
                      </div>
                      <div className="mt-6 flex items-center gap-8">
                        <div className="text-sm text-zinc-500 font-bold uppercase tracking-widest">
                          Moves <span className="text-zinc-300 ml-2">{bottomState.moves}</span>
                        </div>
                        {bottomState.isFlagged && (
                          <div className="text-red-500 animate-bounce">
                            <Flag size={32} fill="currentColor" />
                          </div>
                        )}
                      </div>
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>

        {/* Footer Info */}
        <div className="absolute bottom-4 left-0 right-0 flex justify-center pointer-events-none">
          <div className="px-4 py-1.5 bg-black/40 backdrop-blur-md rounded-full border border-white/5 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">
            Professional Tournament Clock • {activeConfig.name}
          </div>
        </div>
        </div>

        {/* Stage Info Bar */}
        <div className="py-3 px-4 sm:px-6 bg-zinc-900/50 border border-zinc-800 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 text-sm">
          <div className="flex flex-col items-center sm:items-start">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Active Preset</span>
            <span className="text-zinc-300 italic text-center sm:text-left">{activeConfig.name}</span>
          </div>

          <div className="flex flex-wrap items-center justify-center sm:justify-end gap-4 sm:gap-6">
            <div className="flex flex-col items-center sm:items-end text-center sm:text-right">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Current Stage</span>
              <span className="text-emerald-400 font-bold">
                {activeConfig.stages[activePlayer === 2 ? p2.currentStageIndex : p1.currentStageIndex]?.name || 'N/A'}
              </span>
            </div>
            <div className="hidden sm:block w-px h-8 bg-zinc-800" />
            <div className="flex flex-col items-center sm:items-end text-center sm:text-right">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Stage Duration</span>
              <span className="text-white font-medium">
                {formatTime(activeConfig.stages[activePlayer === 2 ? p2.currentStageIndex : p1.currentStageIndex]?.startTime || 0).replace(/\.\d$/, '')}
              </span>
            </div>
            <div className="hidden sm:block w-px h-8 bg-zinc-800" />
            <div className="flex flex-col items-center sm:items-end text-center sm:text-right">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Increment Per Move</span>
              <span className="text-white font-medium">
                +{activeConfig.stages[activePlayer === 2 ? p2.currentStageIndex : p1.currentStageIndex]?.increment || 0}s
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* History Modal */}
      <AnimatePresence>
        {showHistory && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-2xl max-h-[80vh] flex flex-col"
            >
              <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  <Download className="text-emerald-500" /> Move History
                </h2>
                <div className="flex gap-2">
                  <button 
                    onClick={exportMoveLog}
                    className="p-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors flex items-center gap-2 text-sm font-bold"
                  >
                    <Download size={16} /> Export TXT
                  </button>
                  <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-zinc-800 rounded-full transition-colors">
                    <X size={24} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="text-xs font-bold text-zinc-500 uppercase tracking-widest border-b border-zinc-800">
                      <th className="pb-4">#</th>
                      <th className="pb-4">Player</th>
                      <th className="pb-4">Duration</th>
                      <th className="pb-4">Remaining</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {moveLog.map((m, i) => (
                      <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                        <td className="py-3 text-zinc-500">{m.moveNumber}</td>
                        <td className="py-3 font-medium">Player {m.player}</td>
                        <td className="py-3 font-mono">{m.duration.toFixed(2)}s</td>
                        <td className="py-3 font-mono text-zinc-400">{formatTime(m.timeRemaining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Config Modal */}
      <AnimatePresence>
        {showConfig && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
            >
              <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  <Settings className="text-emerald-500" /> Configuration
                </h2>
                <button onClick={() => { 
                  const close = () => {
                    setShowConfig(false); 
                    setEditingConfig(null); 
                    setOriginalEditingConfig(null);
                  };

                  if (editingConfig && JSON.stringify(editingConfig) !== JSON.stringify(originalEditingConfig)) {
                    setPendingAction(() => close);
                  } else {
                    close();
                  }
                }} className="p-2 hover:bg-zinc-800 rounded-full transition-colors">
                  <X size={24} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 flex flex-col md:flex-row gap-8">
                {/* Section 1: List of configurations */}
                <div className="w-full md:w-1/2 border-b md:border-b-0 md:border-r border-zinc-800 pb-8 md:pb-0 md:pr-8 flex flex-col gap-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Presets</div>
                    <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-tighter">
                      {configs.length} Total
                    </div>
                  </div>

                  <div className="space-y-2">
                    {configs.map(c => (
                      <div
                        key={c.id}
                        onClick={() => setActiveConfigId(c.id)}
                        className={`p-4 rounded-xl text-left transition-all flex items-center justify-between group cursor-pointer border ${
                          activeConfigId === c.id 
                            ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-900/20' 
                            : 'bg-zinc-800/30 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:border-zinc-700'
                        }`}
                      >
                        <div className="flex items-center gap-3 truncate">
                          <div className={`w-2 h-2 rounded-full ${activeConfigId === c.id ? 'bg-white' : 'bg-zinc-700'}`} />
                          <span className="font-medium truncate">{c.name}</span>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button 
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              const startEdit = () => {
                                setEditingConfig(c);
                                setOriginalEditingConfig(JSON.parse(JSON.stringify(c)));
                              };

                              if (editingConfig && JSON.stringify(editingConfig) !== JSON.stringify(originalEditingConfig)) {
                                setPendingAction(() => startEdit);
                              } else {
                                startEdit();
                              }
                            }}
                            className={`p-2 rounded-lg transition-colors ${activeConfigId === c.id ? 'hover:bg-white/20' : 'hover:bg-zinc-700'}`}
                          >
                            <Settings size={14} />
                          </button>
                          {configs.length > 1 && (
                            <button 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                setConfigToDelete(c.id);
                              }}
                              className={`p-2 rounded-lg transition-colors ${activeConfigId === c.id ? 'hover:bg-red-400/20 text-red-200' : 'hover:bg-red-500/10 text-red-400'}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Section 2: Actions or Editor */}
                <div className="flex-1 md:w-1/2">
                  {editingConfig ? (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Editing Preset</div>
                        <button 
                          onClick={() => {
                            setEditingConfig(null);
                            setOriginalEditingConfig(null);
                          }}
                          className="text-[10px] font-bold text-zinc-500 hover:text-white uppercase tracking-widest transition-colors"
                        >
                          Cancel Edit
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Config Name</label>
                          <input 
                            type="text" 
                            value={editingConfig.name || ''}
                            onChange={(e) => setEditingConfig({ ...editingConfig, name: e.target.value })}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-emerald-500 transition-colors text-white"
                          />
                        </div>
                        <div className="flex flex-col">
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Options</label>
                          <label className="flex items-center gap-3 p-3 bg-zinc-800 border border-zinc-700 rounded-xl cursor-pointer hover:bg-zinc-750 transition-colors">
                            <input 
                              type="checkbox" 
                              checked={editingConfig.flaggingStopsClock !== undefined ? editingConfig.flaggingStopsClock : true}
                              onChange={(e) => setEditingConfig({ ...editingConfig, flaggingStopsClock: e.target.checked })}
                              className="w-5 h-5 rounded border-zinc-700 text-emerald-600 focus:ring-emerald-500 bg-zinc-900"
                            />
                            <span className="text-sm font-medium text-zinc-300">Flagging stops clock</span>
                          </label>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">White Player</label>
                          <select 
                            value={editingConfig.whitePlayer || 1}
                            onChange={(e) => setEditingConfig({ ...editingConfig, whitePlayer: (parseInt(e.target.value) || 1) as 1 | 2 })}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-emerald-500 transition-colors text-white"
                          >
                            <option value={1}>Player 1 is White</option>
                            <option value={2}>Player 2 is White</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">White Position</label>
                          <select 
                            value={editingConfig.whitePosition || 'BOTTOM'}
                            onChange={(e) => setEditingConfig({ ...editingConfig, whitePosition: e.target.value as 'TOP' | 'BOTTOM' })}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-emerald-500 transition-colors text-white"
                          >
                            <option value="BOTTOM">White at Bottom</option>
                            <option value="TOP">White at Top</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Player 1 Name</label>
                          <input 
                            type="text" 
                            value={editingConfig.player1Name || ''}
                            onChange={(e) => setEditingConfig({ ...editingConfig, player1Name: e.target.value })}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-emerald-500 transition-colors text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Player 2 Name</label>
                          <input 
                            type="text" 
                            value={editingConfig.player2Name || ''}
                            onChange={(e) => setEditingConfig({ ...editingConfig, player2Name: e.target.value })}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-emerald-500 transition-colors text-white"
                          />
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest">Stages</label>
                          <button 
                            onClick={() => {
                              const newStage: Stage = {
                                id: `s-${Date.now()}`,
                                name: `Stage ${editingConfig.stages.length + 1}`,
                                startTime: 1800,
                                endTime: 0,
                                direction: TimerDirection.DOWN,
                                movesInStage: 999,
                                increment: 0
                              };
                              setEditingConfig({ ...editingConfig, stages: [...editingConfig.stages, newStage] });
                            }}
                            className="text-emerald-500 hover:text-emerald-400 text-sm font-bold flex items-center gap-1"
                          >
                            <Plus size={16} /> Add Stage
                          </button>
                        </div>

                        {editingConfig.stages.map((stage, idx) => (
                          <div key={stage.id} className="bg-zinc-800/50 border border-zinc-800 rounded-2xl p-4 space-y-4">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-bold text-zinc-400">Stage {idx + 1}</span>
                              {editingConfig.stages.length > 1 && (
                                <button 
                                  onClick={() => {
                                    const next = editingConfig.stages.filter(s => s.id !== stage.id);
                                    setEditingConfig({ ...editingConfig, stages: next });
                                  }}
                                  className="text-red-400 hover:text-red-300"
                                >
                                  <Trash2 size={16} />
                                </button>
                              )}
                            </div>

                              <div className="grid grid-cols-1 gap-4">
                                <div className="grid grid-cols-2 gap-4">
                                  <div>
                                    <label className="block text-[10px] text-zinc-500 uppercase mb-1">Starts at Move</label>
                                    <input 
                                      type="number" 
                                      readOnly
                                      value={getStageStartMove(editingConfig.stages, idx) || 1}
                                      className="w-full bg-zinc-900/50 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-500 cursor-not-allowed"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[10px] text-zinc-500 uppercase mb-1">Number of moves</label>
                                    <input 
                                      type="number" 
                                      value={stage.movesInStage || 0}
                                      onChange={(e) => {
                                        const next = [...editingConfig.stages];
                                        next[idx] = { ...stage, movesInStage: parseInt(e.target.value) || 0 };
                                        setEditingConfig({ ...editingConfig, stages: next });
                                      }}
                                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-white"
                                    />
                                  </div>
                                </div>
                                <div>
                                  <label className="block text-[10px] text-zinc-500 uppercase mb-1">Start Time (H:M:S)</label>
                                <div className="flex gap-2">
                                  <input 
                                    type="number" 
                                    placeholder="H"
                                    value={secondsToHMS(stage.startTime).h || 0}
                                    onChange={(e) => {
                                      const hms = secondsToHMS(stage.startTime);
                                      const next = [...editingConfig.stages];
                                      next[idx] = { ...stage, startTime: hmsToSeconds(parseInt(e.target.value) || 0, hms.m, hms.s) };
                                      setEditingConfig({ ...editingConfig, stages: next });
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-center text-white"
                                  />
                                  <input 
                                    type="number" 
                                    placeholder="M"
                                    value={secondsToHMS(stage.startTime).m || 0}
                                    onChange={(e) => {
                                      const hms = secondsToHMS(stage.startTime);
                                      const next = [...editingConfig.stages];
                                      next[idx] = { ...stage, startTime: hmsToSeconds(hms.h, parseInt(e.target.value) || 0, hms.s) };
                                      setEditingConfig({ ...editingConfig, stages: next });
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-center text-white"
                                  />
                                  <input 
                                    type="number" 
                                    placeholder="S"
                                    value={secondsToHMS(stage.startTime).s || 0}
                                    onChange={(e) => {
                                      const hms = secondsToHMS(stage.startTime);
                                      const next = [...editingConfig.stages];
                                      next[idx] = { ...stage, startTime: hmsToSeconds(hms.h, hms.m, parseInt(e.target.value) || 0) };
                                      setEditingConfig({ ...editingConfig, stages: next });
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-center text-white"
                                  />
                                </div>
                              </div>
                              <div>
                                <label className="block text-[10px] text-zinc-500 uppercase mb-1">Increment (H:M:S)</label>
                                <div className="flex gap-2">
                                  <input 
                                    type="number" 
                                    placeholder="H"
                                    value={secondsToHMS(stage.increment).h || 0}
                                    onChange={(e) => {
                                      const hms = secondsToHMS(stage.increment);
                                      const next = [...editingConfig.stages];
                                      next[idx] = { ...stage, increment: hmsToSeconds(parseInt(e.target.value) || 0, hms.m, hms.s) };
                                      setEditingConfig({ ...editingConfig, stages: next });
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-center text-white"
                                  />
                                  <input 
                                    type="number" 
                                    placeholder="M"
                                    value={secondsToHMS(stage.increment).m || 0}
                                    onChange={(e) => {
                                      const hms = secondsToHMS(stage.increment);
                                      const next = [...editingConfig.stages];
                                      next[idx] = { ...stage, increment: hmsToSeconds(hms.h, parseInt(e.target.value) || 0, hms.s) };
                                      setEditingConfig({ ...editingConfig, stages: next });
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-center text-white"
                                  />
                                  <input 
                                    type="number" 
                                    placeholder="S"
                                    value={secondsToHMS(stage.increment).s || 0}
                                    onChange={(e) => {
                                      const hms = secondsToHMS(stage.increment);
                                      const next = [...editingConfig.stages];
                                      next[idx] = { ...stage, increment: hmsToSeconds(hms.h, hms.m, parseInt(e.target.value) || 0) };
                                      setEditingConfig({ ...editingConfig, stages: next });
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-center text-white"
                                  />
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <label className="block text-[10px] text-zinc-500 uppercase mb-1">Direction</label>
                                  <select 
                                    value={stage.direction}
                                    onChange={(e) => {
                                      const next = [...editingConfig.stages];
                                      next[idx] = { ...stage, direction: e.target.value as TimerDirection };
                                      setEditingConfig({ ...editingConfig, stages: next });
                                    }}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-sm text-white"
                                  >
                                    <option value={TimerDirection.DOWN}>Count Down</option>
                                    <option value={TimerDirection.UP}>Count Up</option>
                                  </select>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      <button 
                        onClick={() => {
                          const next = configs.map(c => c.id === editingConfig.id ? editingConfig : c);
                          saveConfigs(next);
                          setEditingConfig(null);
                          setOriginalEditingConfig(null);
                        }}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-[0.98] shadow-lg shadow-emerald-900/20"
                      >
                        <Save size={18} /> Save Changes
                      </button>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col gap-8">
                      {/* Actions Section */}
                      <div className="space-y-6">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Actions</div>
                          {user ? (
                            <div className="flex items-center gap-2 text-[10px] font-bold text-emerald-500 uppercase tracking-tighter">
                              <Cloud size={12} /> Cloud Sync Active
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">
                              <CloudOff size={12} /> Local Only
                            </div>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {/* Cloud Sync Card */}
                          <div className="col-span-1 sm:col-span-2 bg-zinc-800/30 border border-zinc-800 rounded-2xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
                            <div className="flex items-center gap-4">
                              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${user ? 'bg-emerald-500/10 text-emerald-500' : 'bg-zinc-700/30 text-zinc-500'}`}>
                                <Cloud size={24} />
                              </div>
                              <div className="text-center sm:text-left">
                                <h4 className="font-bold text-white">Cloud Synchronization</h4>
                                <p className="text-xs text-zinc-500">
                                  {user 
                                    ? `Signed in as ${user.displayName || user.email}` 
                                    : 'Sign in to sync your presets across all devices'}
                                </p>
                              </div>
                            </div>
                            {user ? (
                              <button 
                                onClick={logout}
                                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-red-500/10 hover:text-red-400 text-zinc-400 transition-all text-sm font-bold flex items-center gap-2"
                              >
                                <LogOut size={16} /> Sign Out
                              </button>
                            ) : (
                              <button 
                                onClick={login}
                                className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition-all text-sm font-bold flex items-center gap-2 shadow-lg shadow-emerald-900/20"
                              >
                                <LogIn size={16} /> Sign In
                              </button>
                            )}
                          </div>

                          {/* Add Custom Button */}
                          <button 
                            onClick={() => {
                              const addNew = () => {
                                const newId = `custom-${Date.now()}`;
                                const newConf: ClockConfig = {
                                  id: newId,
                                  name: 'New Configuration',
                                  player1Name: 'Player 1',
                                  player2Name: 'Player 2',
                                  whitePlayer: 1,
                                  whitePosition: 'BOTTOM',
                                  flaggingStopsClock: true,
                                  stages: [{
                                    id: 's1',
                                    name: 'Stage 1',
                                    startTime: 3600,
                                    endTime: 0,
                                    direction: TimerDirection.DOWN,
                                    movesInStage: 999,
                                    increment: 0
                                  }]
                                };
                                saveConfigs([...configs, newConf]);
                                setActiveConfigId(newId);
                                setEditingConfig(newConf);
                                setOriginalEditingConfig(JSON.parse(JSON.stringify(newConf)));
                              };

                              if (editingConfig && JSON.stringify(editingConfig) !== JSON.stringify(originalEditingConfig)) {
                                setPendingAction(() => addNew);
                              } else {
                                addNew();
                              }
                            }}
                            className="p-8 rounded-2xl border-2 border-dashed border-zinc-800 text-zinc-500 hover:border-emerald-500 hover:text-emerald-500 hover:bg-emerald-500/5 transition-all flex flex-col items-center justify-center gap-3 group"
                          >
                            <div className="w-12 h-12 rounded-full bg-zinc-800 group-hover:bg-emerald-500/10 flex items-center justify-center transition-colors">
                              <Plus size={24} />
                            </div>
                            <span className="font-bold">Add Custom Preset</span>
                          </button>

                          {/* Data Management */}
                          <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                              <button 
                                onClick={exportConfigs}
                                className="p-6 rounded-2xl bg-zinc-800/30 border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all flex flex-col items-center justify-center gap-2 font-bold text-sm"
                              >
                                <Download size={20} />
                                <span>Export</span>
                              </button>
                              <button 
                                onClick={() => fileInputRef.current?.click()}
                                className="p-6 rounded-2xl bg-zinc-800/30 border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all flex flex-col items-center justify-center gap-2 font-bold text-sm"
                              >
                                <Upload size={20} />
                                <span>Import</span>
                              </button>
                            </div>
                            <button 
                              onClick={() => setShowResetConfirm(true)}
                              className="w-full p-6 rounded-2xl border border-red-500/20 text-red-500/60 hover:text-red-500 hover:bg-red-500/5 transition-all flex items-center justify-center gap-3 font-bold text-sm"
                            >
                              <RotateCcw size={18} /> Reset All Configurations
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="mt-auto pt-8 border-t border-zinc-800/50 flex flex-col items-center text-center space-y-2">
                        <div className="w-12 h-12 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-600">
                          <Settings size={24} strokeWidth={1.5} />
                        </div>
                        <p className="text-sm text-zinc-500">Select a preset from the list on the left to edit its specific timing rules and stages.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="p-6 border-t border-zinc-800 flex justify-end">
                <button 
                  onClick={() => { 
                    const close = () => {
                      setShowConfig(false); 
                      setEditingConfig(null); 
                      setOriginalEditingConfig(null);
                    };

                    if (editingConfig && JSON.stringify(editingConfig) !== JSON.stringify(originalEditingConfig)) {
                      setPendingAction(() => close);
                    } else {
                      close();
                    }
                  }}
                  className="px-8 py-3 bg-zinc-800 hover:bg-zinc-700 text-white font-bold rounded-xl transition-all active:scale-95 flex items-center gap-2"
                >
                  <Check size={20} /> OK
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Arbitration Modal */}
      <AnimatePresence>
        {showArbitration && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-2xl p-8 space-y-8"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  <Gavel className="text-amber-500" /> Arbitration
                </h2>
                <button onClick={() => setShowArbitration(false)} className="p-2 hover:bg-zinc-800 rounded-full transition-colors">
                  <X size={24} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-8">
                {/* Player 1 Adjust */}
                <div className="space-y-4">
                  <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Player 1</div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[10px] text-zinc-500 uppercase mb-1">Time (H:M:S)</label>
                      <div className="flex gap-2">
                        <input 
                          type="number" 
                          placeholder="H"
                          value={secondsToHMS(p1.time).h || 0}
                          onChange={(e) => {
                            const hms = secondsToHMS(p1.time);
                            setP1({ ...p1, time: hmsToSeconds(parseInt(e.target.value) || 0, hms.m, hms.s) });
                          }}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-amber-500 text-center text-white"
                        />
                        <input 
                          type="number" 
                          placeholder="M"
                          value={secondsToHMS(p1.time).m || 0}
                          onChange={(e) => {
                            const hms = secondsToHMS(p1.time);
                            setP1({ ...p1, time: hmsToSeconds(hms.h, parseInt(e.target.value) || 0, hms.s) });
                          }}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-amber-500 text-center text-white"
                        />
                        <input 
                          type="number" 
                          placeholder="S"
                          value={secondsToHMS(p1.time).s || 0}
                          onChange={(e) => {
                            const hms = secondsToHMS(p1.time);
                            setP1({ ...p1, time: hmsToSeconds(hms.h, hms.m, parseInt(e.target.value) || 0) });
                          }}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-amber-500 text-center text-white"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 uppercase mb-1">Moves</label>
                      <input 
                        type="number" 
                        value={p1.moves || 0}
                        onChange={(e) => setP1({ ...p1, moves: parseInt(e.target.value) || 0 })}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-amber-500 text-white"
                      />
                    </div>
                  </div>
                </div>

                {/* Player 2 Adjust */}
                <div className="space-y-4">
                  <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Player 2</div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[10px] text-zinc-500 uppercase mb-1">Time (H:M:S)</label>
                      <div className="flex gap-2">
                        <input 
                          type="number" 
                          placeholder="H"
                          value={secondsToHMS(p2.time).h || 0}
                          onChange={(e) => {
                            const hms = secondsToHMS(p2.time);
                            setP2({ ...p2, time: hmsToSeconds(parseInt(e.target.value) || 0, hms.m, hms.s) });
                          }}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-amber-500 text-center text-white"
                        />
                        <input 
                          type="number" 
                          placeholder="M"
                          value={secondsToHMS(p2.time).m || 0}
                          onChange={(e) => {
                            const hms = secondsToHMS(p2.time);
                            setP2({ ...p2, time: hmsToSeconds(hms.h, parseInt(e.target.value) || 0, hms.s) });
                          }}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-amber-500 text-center text-white"
                        />
                        <input 
                          type="number" 
                          placeholder="S"
                          value={secondsToHMS(p2.time).s || 0}
                          onChange={(e) => {
                            const hms = secondsToHMS(p2.time);
                            setP2({ ...p2, time: hmsToSeconds(hms.h, hms.m, parseInt(e.target.value) || 0) });
                          }}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-amber-500 text-center text-white"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 uppercase mb-1">Moves</label>
                      <input 
                        type="number" 
                        value={p2.moves || 0}
                        onChange={(e) => setP2({ ...p2, moves: parseInt(e.target.value) || 0 })}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 focus:outline-none focus:border-amber-500 text-white"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <button 
                onClick={() => setShowArbitration(false)}
                className="w-full bg-amber-600 hover:bg-amber-500 text-black font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-colors"
              >
                <Check size={20} /> Apply Adjustments
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {configToDelete && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-md p-8 space-y-6 text-center"
            >
              <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto text-red-500">
                <Trash2 size={40} />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-bold text-white">Delete Preset?</h3>
                <p className="text-zinc-400">Are you sure you want to delete this configuration? This action cannot be undone.</p>
              </div>
              <div className="flex gap-4">
                <button 
                  onClick={() => setConfigToDelete(null)}
                  className="flex-1 py-4 bg-zinc-800 hover:bg-zinc-700 text-white font-bold rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    deleteConfig(configToDelete);
                    setConfigToDelete(null);
                  }}
                  className="flex-1 py-4 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl transition-all"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Unsaved Changes Prompt */}
      <AnimatePresence>
        {pendingAction && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-md p-8 space-y-6 text-center"
            >
              <div className="w-20 h-20 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto text-amber-500">
                <Save size={40} />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-bold text-white">Unsaved Changes</h3>
                <p className="text-zinc-400">You have unsaved changes in your configuration. Would you like to save them before proceeding?</p>
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => {
                    if (editingConfig) {
                      const next = configs.map(c => c.id === editingConfig.id ? editingConfig : c);
                      saveConfigs(next);
                    }
                    pendingAction();
                    setPendingAction(null);
                  }}
                  className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl transition-all flex items-center justify-center gap-2"
                >
                  <Save size={18} /> Save and Continue
                </button>
                <button 
                  onClick={() => {
                    pendingAction();
                    setPendingAction(null);
                  }}
                  className="w-full py-4 bg-zinc-800 hover:bg-zinc-700 text-white font-bold rounded-xl transition-all"
                >
                  Discard Changes
                </button>
                <button 
                  onClick={() => setPendingAction(null)}
                  className="w-full py-4 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 font-bold rounded-xl transition-all"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reset All Confirmation Modal */}
      <AnimatePresence>
        {showResetConfirm && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] bg-black/95 backdrop-blur-xl flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-md p-8 space-y-6 text-center"
            >
              <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto text-red-500">
                <RotateCcw size={40} />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-bold text-white">Reset All Presets?</h3>
                <p className="text-zinc-400">This will delete all custom configurations and restore the factory defaults. <span className="text-red-400 font-bold">This action cannot be undone.</span></p>
              </div>
              <div className="flex gap-4">
                <button 
                  onClick={() => setShowResetConfirm(false)}
                  className="flex-1 py-4 bg-zinc-800 hover:bg-zinc-700 text-white font-bold rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    resetAllConfigs();
                    setShowResetConfirm(false);
                  }}
                  className="flex-1 py-4 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl transition-all"
                >
                  Reset All
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
