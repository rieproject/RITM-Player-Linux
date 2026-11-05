// Impor aset gaya Vite yang dipakai pustaka ini (diproses oleh bundler aplikasi).
declare module '*?worker&url' {
  const url: string;
  export default url;
}
