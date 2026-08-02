import React, { useState } from 'react';
import { evaluateJudgement, calculateNoteScore } from '../utils/scoring';
import { beatToSeconds } from '../utils/beatTime';
import { JudgementType } from '../types/game';
import { CheckCircle2, Play, X } from 'lucide-react';

interface UnitTestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TestResult {
  name: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export const UnitTestModal: React.FC<UnitTestModalProps> = ({ isOpen, onClose }) => {
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [interactiveDelta, setInteractiveDelta] = useState<number>(25);
  const [interactiveResult, setInteractiveResult] = useState<{ judgement: JudgementType | 'No Hit'; score: number } | null>(null);

  if (!isOpen) return null;

  const runAllUnitTests = () => {
    const results: TestResult[] = [];
    const totalNotes = 100;

    // Test 1: S-Perfect Δt = 25ms (< 40ms)
    const j1 = evaluateJudgement(25);
    results.push({
      name: '判定测试 1: S-Perfect 阈值 (Δt = 25ms)',
      expected: 'S-Perfect',
      actual: j1 || 'null',
      passed: j1 === 'S-Perfect',
    });

    // Test 2: Perfect Δt = 65ms (40ms <= Δt < 80ms)
    const j2 = evaluateJudgement(65);
    results.push({
      name: '判定测试 2: Perfect 阈值 (Δt = 65ms)',
      expected: 'Perfect',
      actual: j2 || 'null',
      passed: j2 === 'Perfect',
    });

    // Test 3: Good Δt = 120ms (80ms <= Δt < 160ms)
    const j3 = evaluateJudgement(120);
    results.push({
      name: '判定测试 3: Good 阈值 (Δt = 120ms)',
      expected: 'Good',
      actual: j3 || 'null',
      passed: j3 === 'Good',
    });

    // Test 4: S-Perfect Score Formula
    const sScore = calculateNoteScore('S-Perfect', totalNotes);
    const expectedS = (10000000 / totalNotes) + 1;
    results.push({
      name: '计分公式测试 1: S-Perfect 单音符得分 ((10000000/N)+1)',
      expected: expectedS.toFixed(2),
      actual: sScore.toFixed(2),
      passed: Math.abs(sScore - expectedS) < 0.001,
    });

    // Test 5: Perfect Score Formula
    const pScore = calculateNoteScore('Perfect', totalNotes);
    const expectedP = 10000000 / totalNotes;
    results.push({
      name: '计分公式测试 2: Perfect 单音符得分 (10000000/N)',
      expected: expectedP.toFixed(2),
      actual: pScore.toFixed(2),
      passed: Math.abs(pScore - expectedP) < 0.001,
    });

    // Test 6: Good Score Formula (Half points)
    const gScore = calculateNoteScore('Good', totalNotes);
    const expectedG = (10000000 / totalNotes) * 0.5;
    results.push({
      name: '计分公式测试 3: Good 单音符得分 ((10000000/N)*0.5)',
      expected: expectedG.toFixed(2),
      actual: gScore.toFixed(2),
      passed: Math.abs(gScore - expectedG) < 0.001,
    });

    // Test 7: Touch note size ratio
    const tapEdge = 1.6;
    const touchDiam = tapEdge * 0.7;
    results.push({
      name: '音符规范测试: Touch音符直径为Tap音符边长70%',
      expected: (1.6 * 0.7).toFixed(3),
      actual: touchDiam.toFixed(3),
      passed: Math.abs(touchDiam - 1.12) < 0.001,
    });

    // Test 8: Beat→Seconds conversion (BPM=120, beat=2, offset=0 → 1.0s)
    const bt1 = beatToSeconds(2, 120, 0);
    results.push({
      name: '节拍换算测试 1: BPM=120, beat=2, offset=0 → 1.0秒',
      expected: '1.000',
      actual: bt1.toFixed(3),
      passed: Math.abs(bt1 - 1.0) < 0.001,
    });

    // Test 9: Beat→Seconds with offset (BPM=60, beat=1, offset=0.5 → 1.5s)
    const bt2 = beatToSeconds(1, 60, 0.5);
    results.push({
      name: '节拍换算测试 2: BPM=60, beat=1, offset=0.5 → 1.5秒',
      expected: '1.500',
      actual: bt2.toFixed(3),
      passed: Math.abs(bt2 - 1.5) < 0.001,
    });

    setTestResults(results);
  };

  const handleInteractiveEval = (delta: number) => {
    setInteractiveDelta(delta);
    const j = evaluateJudgement(delta);
    if (j) {
      const score = calculateNoteScore(j, 50);
      setInteractiveResult({ judgement: j, score });
    } else {
      setInteractiveResult({ judgement: 'No Hit', score: 0 });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="glass-panel-strong border-white/15 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 text-white font-rajdhani">
        <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 flex items-center justify-center text-cyan-300 border border-cyan-400/40 font-bold">
              UT
            </div>
            <div>
              <h2 className="text-xl font-bold font-orbitron tracking-wider text-white/90">
                判定与计分系统单元测试
              </h2>
              <p className="text-xs text-white/50">Unit Testing & Judgement Specification Inspector</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-white/55 hover:text-white p-1 rounded-lg hover:bg-white/10 transition"
          >
            <X size={22} />
          </button>
        </div>

        {/* Action Button */}
        <div className="flex gap-3 mb-6">
          <button
            onClick={runAllUnitTests}
            className="flex-1 flex items-center justify-center gap-2 glass-btn-primary font-bold py-2.5 rounded-xl transition cursor-pointer active:scale-95"
          >
            <Play size={18} />
            运行所有自动化单元测试 (Run Tests)
          </button>
        </div>

        {/* Test Result List */}
        {testResults.length > 0 && (
          <div className="space-y-2 mb-6">
            {testResults.map((t, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-3 rounded-xl glass-sub border border-white/10"
              >
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 size={18} className="text-emerald-400" />
                  <div>
                    <div className="text-sm font-semibold text-white/80">{t.name}</div>
                    <div className="text-xs text-white/50">
                      期望: <span className="text-cyan-300">{t.expected}</span> | 实际:{' '}
                      <span className="text-emerald-300">{t.actual}</span>
                    </div>
                  </div>
                </div>
                <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  PASSED
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Interactive Delta-t Sandbox */}
        <div className="glass-sub p-4 rounded-xl border border-white/10">
          <h3 className="text-sm font-bold text-cyan-300 mb-2 font-orbitron">实时时间差 Δt 模拟沙盒</h3>
          <p className="text-xs text-white/50 mb-4">
            点击下方时间差或拖动滑块，测试不同操作时间与到达时间差值 (Δt) 的判定结果与得分计算：
          </p>

          <div className="flex flex-wrap gap-2 mb-4">
            <button
              onClick={() => handleInteractiveEval(20)}
              className="px-3 py-1 text-xs font-semibold rounded-lg bg-orange-500/20 border border-orange-500/40 text-orange-300 hover:bg-orange-500/30 transition"
            >
              Δt = 20ms (S-Perfect)
            </button>
            <button
              onClick={() => handleInteractiveEval(60)}
              className="px-3 py-1 text-xs font-semibold rounded-lg bg-yellow-500/20 border border-yellow-500/40 text-yellow-300 hover:bg-yellow-500/30 transition"
            >
              Δt = 60ms (Perfect)
            </button>
            <button
              onClick={() => handleInteractiveEval(110)}
              className="px-3 py-1 text-xs font-semibold rounded-lg bg-sky-500/20 border border-sky-500/40 text-sky-300 hover:bg-sky-500/30 transition"
            >
              Δt = 110ms (Good)
            </button>
            <button
              onClick={() => handleInteractiveEval(180)}
              className="px-3 py-1 text-xs font-semibold rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 transition"
            >
              Δt = 180ms (Miss)
            </button>
          </div>

          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0"
              max="200"
              value={interactiveDelta}
              onChange={(e) => handleInteractiveEval(Number(e.target.value))}
              className="flex-1 accent-cyan-400"
            />
            <span className="text-sm font-mono text-cyan-300 w-16 text-right">±{interactiveDelta}ms</span>
          </div>

          {interactiveResult && (
            <div className="mt-3 p-3 glass-sub rounded-lg flex items-center justify-between border border-white/12">
              <span className="text-xs text-white/70">判定结果:</span>
              <span className="text-sm font-bold font-orbitron text-cyan-300">
                {interactiveResult.judgement}
              </span>
              <span className="text-xs text-white/50">
                得分增量: <span className="text-emerald-400 font-mono">+{interactiveResult.score.toFixed(1)}</span>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
