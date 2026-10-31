import WalletConsole from "./WalletConsole";
import "./wallet.css";
export const metadata = {
  title: "Wallet Control | Shards Agent Trading Network",
  description:
    "Verify operator wallets and link them to governed Shards without granting trading authority.",
};
export default function WalletPage() {
  return <WalletConsole />;
}
