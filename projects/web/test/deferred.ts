/** Node supports withResolvers; the web package's ES2023 lib predates its type. */
export function deferred<T>() {
  const promiseConstructor = Promise as unknown as {
    withResolvers<U>(): {
      promise: Promise<U>;
      resolve: (value: U | PromiseLike<U>) => void;
      reject: (reason?: unknown) => void;
    };
  };
  return promiseConstructor.withResolvers<T>();
}
