import { ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import { ApiError } from './api';

export interface Resource<T> {
  data: ShallowRef<T | null>;
  error: Ref<ApiError | null>;
  loading: Ref<boolean>;
  run: () => Promise<void>;
}

/** Wraps an async loader with loading/error state so each view can show a daemon-off or timeout banner. */
export function useResource<T>(loader: () => Promise<T>): Resource<T> {
  const data = shallowRef<T | null>(null);
  const error = ref<ApiError | null>(null);
  const loading = ref(false);
  async function run(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      data.value = await loader();
    } catch (e) {
      error.value = e instanceof ApiError ? e : new ApiError('daemon_off');
    } finally {
      loading.value = false;
    }
  }
  return { data, error, loading, run };
}
