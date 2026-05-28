/**
 * HomeScreen — model download + engine load.
 *
 * The user downloads the demo model here (with a live progress bar),
 * then loads it into the inference engine. Once loaded they can
 * navigate to the Chat or Models screen.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RootStackParamList } from '../App';
import { client, DEMO_MODEL_ID, DEMO_MODEL_NAME } from '../bitnet';
import type { DownloadProgress } from 'react-native-bitnet';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

type Phase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'loading'
  | 'ready'
  | 'error';

export default function HomeScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);          // 0–1
  const [progressLabel, setProgressLabel] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [storageInfo, setStorageInfo] = useState<string>('');
  const barAnim = useRef(new Animated.Value(0)).current;
  const abortRef = useRef<AbortController | null>(null);

  // Animate the progress bar whenever `progress` changes
  useEffect(() => {
    Animated.timing(barAnim, {
      toValue: progress,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [progress, barAnim]);

  // On mount check if the model is already downloaded
  useEffect(() => {
    (async () => {
      setPhase('checking');
      try {
        const downloaded = await client.isModelDownloaded(DEMO_MODEL_ID);
        const loaded = client.isModelLoaded();
        if (loaded) {
          setPhase('ready');
        } else if (downloaded) {
          setPhase('idle'); // ready to load but not yet in engine
          setProgressLabel('Model cached — tap "Load Model" to start.');
        } else {
          setPhase('idle');
        }
        await refreshStorage();
      } catch {
        setPhase('idle');
      }
    })();
  }, []);

  const refreshStorage = useCallback(async () => {
    try {
      const info = await client.getStorageInfo();
      const mb = (info.totalBytes / (1024 * 1024)).toFixed(1);
      setStorageInfo(`${info.modelCount} model(s) cached — ${mb} MB used`);
    } catch {
      setStorageInfo('');
    }
  }, []);

  // ── Download ────────────────────────────────────────────────────────────────

  const handleDownload = useCallback(async () => {
    setPhase('downloading');
    setProgress(0);
    setProgressLabel('Starting download…');
    setErrorMsg('');

    abortRef.current = new AbortController();

    try {
      await client.downloadModel(DEMO_MODEL_ID, {
        onProgress: (p: DownloadProgress) => {
          const pct = p.progress >= 0 ? p.progress : 0;
          setProgress(pct);
          const received = (p.bytesReceived / (1024 * 1024)).toFixed(1);
          const total =
            p.totalBytes > 0
              ? `/ ${(p.totalBytes / (1024 * 1024)).toFixed(1)} MB`
              : '';
          setProgressLabel(`${received} MB ${total} (${(pct * 100).toFixed(1)}%)`);
        },
      });
      setProgressLabel('Download complete ✓');
      await refreshStorage();
      // Auto-load after download
      await handleLoad();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase('error');
      setErrorMsg(msg);
    }
  }, [refreshStorage]);

  // ── Load model into engine ──────────────────────────────────────────────────

  const handleLoad = useCallback(async () => {
    setPhase('loading');
    setProgressLabel('Loading model into engine…');
    try {
      await client.loadModel(DEMO_MODEL_ID);
      setPhase('ready');
      setProgressLabel('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase('error');
      setErrorMsg(msg);
    }
  }, []);

  // ── Cancel download ─────────────────────────────────────────────────────────

  const handleCancel = useCallback(() => {
    client.cancelDownload(DEMO_MODEL_ID);
    abortRef.current?.abort();
    setPhase('idle');
    setProgressLabel('Download cancelled');
  }, []);

  // ── Unload ──────────────────────────────────────────────────────────────────

  const handleUnload = useCallback(async () => {
    await client.unloadModel();
    setPhase('idle');
    setProgressLabel('');
    Alert.alert('Unloaded', 'Model removed from memory.');
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  const barWidth = barAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + 16 }]}>
      {/* Header card */}
      <View style={styles.card}>
        <Text style={styles.modelName}>{DEMO_MODEL_NAME}</Text>
        <Text style={styles.modelSub}>1-bit LLM · on-device inference</Text>
        {storageInfo ? (
          <Text style={styles.storageInfo}>{storageInfo}</Text>
        ) : null}
      </View>

      {/* Status */}
      <StatusBadge phase={phase} />

      {/* Progress bar (download / load) */}
      {(phase === 'downloading' || phase === 'loading') && (
        <View style={styles.progressSection}>
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: barWidth }]} />
          </View>
          <Text style={styles.progressLabel}>{progressLabel}</Text>
        </View>
      )}

      {/* Idle status label */}
      {phase === 'idle' && progressLabel ? (
        <Text style={styles.idleLabel}>{progressLabel}</Text>
      ) : null}

      {/* Error */}
      {phase === 'error' && (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Error</Text>
          <Text style={styles.errorMsg}>{errorMsg}</Text>
        </View>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        {phase === 'idle' || phase === 'error' || phase === 'checking' ? (
          <>
            <PrimaryButton
              label="⬇  Download &amp; Load Model"
              onPress={handleDownload}
              disabled={phase === 'checking'}
            />
            <SecondaryButton
              label="📦  Load from Cache"
              onPress={handleLoad}
              disabled={phase === 'checking'}
            />
          </>
        ) : phase === 'downloading' ? (
          <DangerButton label="✕  Cancel Download" onPress={handleCancel} />
        ) : phase === 'loading' ? (
          <ActivityIndicator color="#7c3aed" style={{ marginTop: 16 }} />
        ) : phase === 'ready' ? (
          <>
            <PrimaryButton
              label="💬  Start Chat"
              onPress={() => navigation.navigate('Chat')}
            />
            <SecondaryButton
              label="📦  Manage Models"
              onPress={() => navigation.navigate('Models')}
            />
            <DangerButton label="🗑  Unload Model" onPress={handleUnload} />
          </>
        ) : null}
      </View>
    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ phase }: { phase: Phase }) {
  const MAP: Record<Phase, { color: string; label: string }> = {
    idle:        { color: '#64748b', label: 'Not loaded' },
    checking:    { color: '#f59e0b', label: 'Checking cache…' },
    downloading: { color: '#3b82f6', label: 'Downloading…' },
    loading:     { color: '#8b5cf6', label: 'Loading into engine…' },
    ready:       { color: '#22c55e', label: '● Ready' },
    error:       { color: '#ef4444', label: '✕ Error' },
  };
  const { color, label } = MAP[phase];
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.btn, styles.btnPrimary, disabled && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.btnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function SecondaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.btn, styles.btnSecondary, disabled && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.btnText, styles.btnTextSecondary]}>{label}</Text>
    </TouchableOpacity>
  );
}

function DangerButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={onPress}>
      <Text style={[styles.btnText, styles.btnTextDanger]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#1e1e38',
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  modelName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  modelSub: {
    fontSize: 13,
    color: '#94a3b8',
  },
  storageInfo: {
    marginTop: 6,
    fontSize: 12,
    color: '#64748b',
  },
  badge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  badgeText: {
    fontSize: 13,
    fontWeight: '600',
  },
  progressSection: {
    gap: 6,
  },
  progressTrack: {
    height: 8,
    backgroundColor: '#1e1e38',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#7c3aed',
    borderRadius: 4,
  },
  progressLabel: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
  },
  idleLabel: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
  },
  errorBox: {
    backgroundColor: '#2d1515',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#ef4444',
    gap: 4,
  },
  errorTitle: {
    color: '#ef4444',
    fontWeight: '700',
    fontSize: 14,
  },
  errorMsg: {
    color: '#fca5a5',
    fontSize: 13,
  },
  actions: {
    marginTop: 8,
    gap: 10,
  },
  btn: {
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#7c3aed',
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#4b5563',
  },
  btnDanger: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  btnTextSecondary: {
    color: '#94a3b8',
  },
  btnTextDanger: {
    color: '#ef4444',
  },
});
