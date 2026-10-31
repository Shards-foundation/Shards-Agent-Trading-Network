import ClaimClient from "./ClaimClient";

export const metadata = { title: "Claim agent | Shards Trading Network", robots: { index: false, follow: false } };
export default async function ClaimAgentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ClaimClient token={token} />;
}
