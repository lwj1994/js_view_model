// Minimal host contract, as with the React Native AppState declaration.
// Taro is an optional peer supplied by the application.
declare module '@tarojs/taro' {
  export function useDidShow(callback: () => void): void;
  export function useDidHide(callback: () => void): void;
  export function useUnload(callback: () => void): void;
}
