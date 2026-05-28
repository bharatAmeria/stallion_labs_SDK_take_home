/**
 * ModelsScreen — local model cache management.
 *
 * Shows all downloaded models, their size, status, and lets the user delete them.
 * Also shows total disk usage.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { client } from '../bitnet';
import type { ModelInfo, StorageInfo } from 'react-native-bitnet';

export default function ModelsScreen() {
  const insets = useSafeAreaInsets();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, info] = await Promise.all([
        client.listModels(),
        client.getStorageInfo(),
      ]);
      setModels(list);
      setStorage(info);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Delete a model ──────────────────────────────────────────────────────────

  const handleDelete = useCallback(
    (model: ModelInfo) => {
      Alert.alert(
        'Delete Model',
        `Delete "${model.id}"?\nThis will free ${formatBytes(model.sizeBytes)}.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              setDeletingId(model.id);
              try {
                await client.deleteModel(model.id);
                await refresh();
              } catch (e: unknown) {
                Alert.alert(
                  'Error',
                  e instanceof Error ? e.message : String(e)
                );
              } finally {
                setDeletingId(null);
              }
            },
          },
        ]
      );
    },
    [refresh]
  );

  // ── Render each model card ──────────────────────────────────────────────────

  const renderModel = useCallback(
    ({ item }: { item: ModelInfo }) => {
      const isDeleting = deletingId === item.id;
      const statusColor = STATUS_COLORS[item.status] ?? '#64748b';

      return (
        <View style={styles.modelCard}>
          <View style={styles.modelInfo}>
            <Text style={styles.modelId} numberOfLines={1}>
              {item.id}
            </Text>
            <View style={styles.modelMeta}>
              <Text style={[styles.modelStatus, { color: statusColor }]}>
                {item.status}
              </Text>
              <Text style={styles.modelSize}>{formatBytes(item.sizeBytes)}</Text>
              {item.downloadedAt ? (
                <Text style={styles.modelDate}>
                  {new Date(item.downloadedAt).toLocaleDateString()}
                </Text>
              ) : null}
            </View>
          </View>

          {isDeleting ? (
            <ActivityIndicator color="#ef4444" />
          ) : (
            <TouchableOpacity
              style={styles.deleteBtn}
              onPress={() => handleDelete(item)}
            >
              <Text style={styles.deleteBtnText}>🗑</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    },
    [deletingId, handleDelete]
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {/* Storage summary */}
      {storage ? (
        <View style={styles.storageCard}>
          <Text style={styles.storageTitle}>Disk Usage</Text>
          <Text style={styles.storageValue}>{formatBytes(storage.totalBytes)}</Text>
          <Text style={styles.storageCount}>
            {storage.modelCount} model{storage.modelCount !== 1 ? 's' : ''}
          </Text>
        </View>
      ) : null}

      {/* Model list */}
      <FlatList
        data={models}
        keyExtractor={m => m.id}
        renderItem={renderModel}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={refresh}
            tintColor="#7c3aed"
            colors={['#7c3aed']}
          />
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>📭</Text>
              <Text style={styles.emptyText}>No models downloaded yet.</Text>
              <Text style={styles.emptySubText}>
                Go to the Home screen to download a model.
              </Text>
            </View>
          ) : null
        }
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  downloaded: '#22c55e',
  downloading: '#3b82f6',
  loading: '#8b5cf6',
  ready: '#22c55e',
  error: '#ef4444',
  not_downloaded: '#64748b',
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  storageCard: {
    margin: 16,
    backgroundColor: '#1e1e38',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  storageTitle: {
    color: '#94a3b8',
    fontSize: 13,
    flex: 1,
  },
  storageValue: {
    color: '#e2e8f0',
    fontSize: 18,
    fontWeight: '700',
  },
  storageCount: {
    color: '#64748b',
    fontSize: 13,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    flexGrow: 1,
  },
  modelCard: {
    backgroundColor: '#1e1e38',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  modelInfo: {
    flex: 1,
    gap: 4,
  },
  modelId: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '600',
  },
  modelMeta: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  modelStatus: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  modelSize: {
    color: '#64748b',
    fontSize: 12,
  },
  modelDate: {
    color: '#4b5563',
    fontSize: 12,
  },
  deleteBtn: {
    padding: 8,
  },
  deleteBtnText: {
    fontSize: 20,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 80,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: '600',
  },
  emptySubText: {
    color: '#4b5563',
    fontSize: 13,
    textAlign: 'center',
  },
});
