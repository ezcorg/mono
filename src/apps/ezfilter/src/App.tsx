import { Router, Route } from "@solidjs/router";
import { Layout } from "./components/layout";
import LoadingPage from "./pages/loading";
import SetupPage from "./pages/setup";
import PluginsPage from "./pages/plugins";
import PluginConfigPage from "./pages/plugin-config";
import SettingsPage from "./pages/settings";
import AdminPage from "./pages/admin";

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={LoadingPage} />
      <Route path="/setup" component={SetupPage} />
      <Route path="/plugins" component={PluginsPage} />
      <Route path="/plugins/:ns/:name/config" component={PluginConfigPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/admin" component={AdminPage} />
    </Router>
  );
}
