//! `agentified analyze <path>` — emits a hardcoded FinanceBot skills manifest plus a Claude Code
//! `.mcp.json` referencing the local Agentified MCP server.
//!
//! The CLI surface is real; the analysis is canned for the showcase iteration. A future iteration
//! will replace `financebot_skills()` with real codebase inspection.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use agentified_lib::models::{EdgeSource, Skill, SkillEdge};
use serde::Serialize;
use serde_json::json;

#[derive(Debug)]
pub struct AnalyzeOutput {
    pub skills_path: PathBuf,
    pub mcp_path: PathBuf,
    pub skill_count: usize,
}

pub fn run(path: &Path, dataset: &str) -> io::Result<AnalyzeOutput> {
    fs::create_dir_all(path)?;

    let skills = financebot_skills();
    let skill_count = skills.len();
    let skills_path = path.join("agentified.skills.json");
    let mcp_path = path.join(".mcp.json");

    let skills_doc = SkillsDoc {
        version: 1,
        dataset: dataset.to_string(),
        skills,
    };
    let skills_json = serde_json::to_string_pretty(&skills_doc).map_err(io::Error::other)?;
    fs::write(&skills_path, format!("{skills_json}\n"))?;

    let mcp_doc = json!({
        "mcpServers": {
            "agentified": {
                "command": "agentified",
                "args": ["mcp", "--dataset", dataset],
            }
        }
    });
    let mcp_json = serde_json::to_string_pretty(&mcp_doc).map_err(io::Error::other)?;
    fs::write(&mcp_path, format!("{mcp_json}\n"))?;

    Ok(AnalyzeOutput {
        skills_path,
        mcp_path,
        skill_count,
    })
}

#[derive(Serialize)]
struct SkillsDoc {
    version: u32,
    dataset: String,
    skills: Vec<Skill>,
}

/// Hardcoded FinanceBot skills. These are the "molecules" that bundle the simulated 100 tools
/// in the FinanceBot showcase into useful workflows.
fn financebot_skills() -> Vec<Skill> {
    vec![
        Skill {
            name: "investigate_anomalous_transactions".into(),
            description: "Find anomalous transactions, gather supporting context, and draft a CFO memo.".into(),
            intent: "When the user wants to investigate suspicious or anomalous activity in the books and produce a written summary for finance leadership.".into(),
            atoms: vec![
                "ledger_list_transactions".into(),
                "ledger_detect_anomalies".into(),
                "ledger_get_transaction".into(),
                "crm_get_contact".into(),
                "docs_search_policy".into(),
                "docs_draft_memo".into(),
                "comms_send_email".into(),
            ],
            edges: vec![
                edge("ledger_list_transactions", "ledger_detect_anomalies"),
                edge("ledger_detect_anomalies", "ledger_get_transaction"),
                edge("ledger_get_transaction", "crm_get_contact"),
                edge("ledger_detect_anomalies", "docs_search_policy"),
                edge("docs_search_policy", "docs_draft_memo"),
                edge("crm_get_contact", "docs_draft_memo"),
                edge("docs_draft_memo", "comms_send_email"),
            ],
            metadata: Some(json!({"source": "financebot-showcase"})),
        },
        Skill {
            name: "month_end_close".into(),
            description: "Run the month-end close: reconcile accounts, post adjusting entries, and publish the close report.".into(),
            intent: "When the user is performing a month-end or quarter-end close and needs to coordinate reconciliation, journal entries, and reporting.".into(),
            atoms: vec![
                "ledger_list_accounts".into(),
                "ledger_reconcile_account".into(),
                "ledger_post_journal_entry".into(),
                "ledger_close_period".into(),
                "docs_draft_report".into(),
                "comms_post_slack".into(),
            ],
            edges: vec![
                edge("ledger_list_accounts", "ledger_reconcile_account"),
                edge("ledger_reconcile_account", "ledger_post_journal_entry"),
                edge("ledger_post_journal_entry", "ledger_close_period"),
                edge("ledger_close_period", "docs_draft_report"),
                edge("docs_draft_report", "comms_post_slack"),
            ],
            metadata: Some(json!({"source": "financebot-showcase"})),
        },
        Skill {
            name: "ar_followup_campaign".into(),
            description: "Identify overdue invoices, segment by customer health, and send tailored follow-ups.".into(),
            intent: "When chasing accounts receivable: who's late, who matters, and what to say.".into(),
            atoms: vec![
                "ledger_list_invoices".into(),
                "ledger_get_invoice_aging".into(),
                "crm_list_contacts".into(),
                "crm_get_contact_health".into(),
                "docs_draft_email".into(),
                "comms_send_email".into(),
            ],
            edges: vec![
                edge("ledger_list_invoices", "ledger_get_invoice_aging"),
                edge("ledger_get_invoice_aging", "crm_list_contacts"),
                edge("crm_list_contacts", "crm_get_contact_health"),
                edge("crm_get_contact_health", "docs_draft_email"),
                edge("docs_draft_email", "comms_send_email"),
            ],
            metadata: Some(json!({"source": "financebot-showcase"})),
        },
        Skill {
            name: "vendor_onboarding".into(),
            description: "Verify a new vendor, register them in the ledger, and notify the team.".into(),
            intent: "When onboarding a new vendor: KYC checks, ledger setup, and team notification.".into(),
            atoms: vec![
                "crm_create_contact".into(),
                "crm_run_kyc_check".into(),
                "ledger_create_vendor".into(),
                "ledger_set_payment_terms".into(),
                "docs_draft_email".into(),
                "comms_post_slack".into(),
            ],
            edges: vec![
                edge("crm_create_contact", "crm_run_kyc_check"),
                edge("crm_run_kyc_check", "ledger_create_vendor"),
                edge("ledger_create_vendor", "ledger_set_payment_terms"),
                edge("ledger_set_payment_terms", "docs_draft_email"),
                edge("docs_draft_email", "comms_post_slack"),
            ],
            metadata: Some(json!({"source": "financebot-showcase"})),
        },
        Skill {
            name: "expense_audit".into(),
            description: "Audit expense reports against policy, flag exceptions, and route for approval.".into(),
            intent: "When auditing employee expense reports for policy compliance.".into(),
            atoms: vec![
                "ledger_list_expense_reports".into(),
                "docs_search_policy".into(),
                "ledger_flag_expense_exception".into(),
                "crm_get_contact".into(),
                "comms_send_email".into(),
            ],
            edges: vec![
                edge("ledger_list_expense_reports", "docs_search_policy"),
                edge("docs_search_policy", "ledger_flag_expense_exception"),
                edge("ledger_flag_expense_exception", "crm_get_contact"),
                edge("crm_get_contact", "comms_send_email"),
            ],
            metadata: Some(json!({"source": "financebot-showcase"})),
        },
    ]
}

fn edge(from: &str, to: &str) -> SkillEdge {
    SkillEdge {
        from: from.into(),
        to: to.into(),
        source: EdgeSource::Developer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn analyze_writes_skills_and_mcp_files() {
        let dir = tempdir().unwrap();
        let out = run(dir.path(), "financebot").unwrap();

        assert!(out.skills_path.exists(), "skills file should exist");
        assert!(out.mcp_path.exists(), "mcp file should exist");
        assert!(
            out.skill_count >= 5,
            "expected at least 5 financebot skills"
        );

        let skills_raw = fs::read_to_string(&out.skills_path).unwrap();
        let skills_doc: serde_json::Value = serde_json::from_str(&skills_raw).unwrap();
        assert_eq!(skills_doc["version"], 1);
        assert_eq!(skills_doc["dataset"], "financebot");
        let skills = skills_doc["skills"].as_array().unwrap();
        assert_eq!(skills.len(), out.skill_count);

        // Sanity-check the headline demo skill.
        let names: Vec<&str> = skills.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"investigate_anomalous_transactions"));

        let mcp_raw = fs::read_to_string(&out.mcp_path).unwrap();
        let mcp: serde_json::Value = serde_json::from_str(&mcp_raw).unwrap();
        assert_eq!(mcp["mcpServers"]["agentified"]["command"], "agentified");
        let args = mcp["mcpServers"]["agentified"]["args"].as_array().unwrap();
        assert!(args.iter().any(|v| v == "mcp"));
        assert!(args.iter().any(|v| v == "financebot"));
    }

    #[test]
    fn analyze_creates_path_if_missing() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        let out = run(&nested, "default").unwrap();
        assert!(out.skills_path.exists());
        assert!(out.mcp_path.exists());
    }

    #[test]
    fn analyze_uses_dataset_in_mcp_args() {
        let dir = tempdir().unwrap();
        let out = run(dir.path(), "my-finance").unwrap();
        let mcp: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&out.mcp_path).unwrap()).unwrap();
        let args = mcp["mcpServers"]["agentified"]["args"].as_array().unwrap();
        assert_eq!(args.last().unwrap(), "my-finance");
    }
}
