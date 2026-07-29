// This page is never reached — middleware rewrites `/` to `/api/index` where
// the actual HTML is generated. This stub only exists so `next build` has
// at least one page to compile.
export default function StubIndex() {
  return null;
}
export async function getServerSideProps() {
  return { notFound: true };
}
