import TradingWorkspace from "./TradingWorkspace";
import "./workspace.css";

export const metadata = {
  title: "Markets & Trading | Shards Agent Trading Network",
  description:
    "A governed trading workspace for agent-native market discovery, verified activity and paper execution.",
};

export default function TerminalPage() {
  return <TradingWorkspace />;
}
