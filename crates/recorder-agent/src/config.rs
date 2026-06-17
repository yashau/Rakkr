use clap::Parser;

#[derive(Clone, Debug, Parser)]
#[command(author, version, about = "Rakkr recorder node agent")]
pub struct AgentConfig {
    #[arg(
        long,
        env = "RAKKR_CONTROLLER_URL",
        default_value = "http://localhost:8787"
    )]
    pub controller_url: String,

    #[arg(long, env = "RAKKR_NODE_ID", default_value = "node_local_dev")]
    pub node_id: String,

    #[arg(long, env = "RAKKR_NODE_ALIAS", default_value = "Local Recorder Node")]
    pub alias: String,

    #[arg(long, env = "RAKKR_NODE_SITE", default_value = "Unassigned Site")]
    pub site: String,

    #[arg(long, env = "RAKKR_NODE_ROOM", default_value = "Unassigned Room")]
    pub room: String,

    #[arg(long, env = "RAKKR_HEARTBEAT_SECONDS", default_value_t = 5)]
    pub heartbeat_seconds: u64,

    #[arg(long, default_value_t = false)]
    pub print_inventory: bool,
}
