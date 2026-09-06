//! GitLab over REST v4 (see `api`). glab only supplies the token.

use reqwest::Method;
use sqlx::SqlitePool;

use crate::core::db::models::{Mr, Repo, Worktree};
use crate::core::db::store;

use crate::core::forge::api::{self, gitlab_project_ref, pct};
use super::client::PlatformClient;

fn project_ref(repo: &Repo) -> String {
    gitlab_project_ref(&repo.group_path, &repo.project)
}

fn mr_path(repo: &Repo, remote_id: &str) -> String {
    format!("projects/{}/merge_requests/{remote_id}", project_ref(repo))
}

pub(super) fn glab_state(raw: &str) -> String {
    match raw {
        "opened" => "open".to_string(),
        other => other.to_string(),
    }
}

/// The logged-in user, per host: id for assignment, username for the review
/// queue. One `/user` call per host per run.
pub(super) async fn current_user(host: &str) -> anyhow::Result<(i64, String)> {
    static USERS: std::sync::Mutex<Vec<(String, i64, String)>> = std::sync::Mutex::new(Vec::new());
    if let Ok(cache) = USERS.lock() {
        if let Some((_, id, name)) = cache.iter().find(|(h, _, _)| h == host) {
            return Ok((*id, name.clone()));
        }
    }
    let v = api::gitlab(host, Method::GET, "user", None).await?;
    let id = v["id"].as_i64().ok_or_else(|| anyhow::anyhow!("no id in {host}'s /user"))?;
    let username = v["username"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no username in {host}'s /user"))?
        .to_string();
    if let Ok(mut cache) = USERS.lock() {
        cache.push((host.to_string(), id, username.clone()));
    }
    Ok((id, username))
}

/// One MR fetch — details, state, diff_refs and head_pipeline in one payload.
async fn mr_json(repo: &Repo, remote_id: &str) -> anyhow::Result<serde_json::Value> {
    api::gitlab(&repo.host, Method::GET, &mr_path(repo, remote_id), None).await
}

/// Approval state for an MR addressed by project path — used by the review
/// queue, which lists MRs across projects with no `Repo` row to hand a client.
pub(super) async fn mr_approved(host: &str, project_full: &str, iid: u64) -> bool {
    let path = format!(
        "projects/{}/merge_requests/{iid}/approvals",
        project_full.replace('/', "%2F")
    );
    api::gitlab(host, Method::GET, &path, None)
        .await
        .ok()
        .and_then(|v| {
            v["approved"]
                .as_bool()
                .or_else(|| v["approved_by"].as_array().map(|a| !a.is_empty()))
        })
        .unwrap_or(false)
}

/// Discussions → the UI's `[{ id, notes: [...] }]`. System notes ("added 1
/// commit") are noise, not review content, and are dropped with any discussion
/// they empty out. Pure, so a captured payload pins it.
fn threads_from_discussions(discussions: &serde_json::Value) -> serde_json::Value {
    let threads: Vec<serde_json::Value> = discussions
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|d| {
            let notes: Vec<serde_json::Value> = d["notes"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|n| n["system"].as_bool() != Some(true))
                .collect();
            if notes.is_empty() {
                return None;
            }
            Some(serde_json::json!({ "id": d["id"], "notes": notes }))
        })
        .collect();
    serde_json::Value::Array(threads)
}

pub(super) struct GlabClient;

#[async_trait::async_trait]
impl PlatformClient for GlabClient {
    fn platform_name(&self) -> &'static str {
        "gitlab"
    }

    async fn create_mr(
        &self,
        repo: &Repo,
        branch: &str,
        target: &str,
        title: &str,
        description: &str,
    ) -> anyhow::Result<(String, String)> {
        // Self-assignment is best-effort: an MR without an assignee beats no MR.
        let assignee = current_user(&repo.host).await.ok().map(|(id, _)| id);
        let mut body = serde_json::json!({
            "source_branch": branch,
            "target_branch": target,
            "title": title,
            "description": description,
            "squash": true,
            "remove_source_branch": true,
        });
        if let Some(id) = assignee {
            body["assignee_id"] = serde_json::json!(id);
        }
        let v = api::gitlab(
            &repo.host,
            Method::POST,
            &format!("projects/{}/merge_requests", project_ref(repo)),
            Some(&body),
        )
        .await?;

        let iid = v["iid"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("created MR has no iid: {v}"))?
            .to_string();
        let url = v["web_url"].as_str().unwrap_or("").to_string();
        Ok((iid, url))
    }

    async fn update_mr(
        &self,
        repo: &Repo,
        remote_id: &str,
        title: Option<&str>,
        description: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut body = serde_json::Map::new();
        if let Some(t) = title {
            body.insert("title".into(), serde_json::json!(t));
        }
        if let Some(d) = description {
            body.insert("description".into(), serde_json::json!(d));
        }
        api::gitlab(
            &repo.host,
            Method::PUT,
            &mr_path(repo, remote_id),
            Some(&serde_json::Value::Object(body)),
        )
        .await?;
        Ok(())
    }

    async fn close_mr(&self, repo: &Repo, remote_id: &str) -> anyhow::Result<()> {
        api::gitlab(
            &repo.host,
            Method::PUT,
            &mr_path(repo, remote_id),
            Some(&serde_json::json!({ "state_event": "close" })),
        )
        .await?;
        Ok(())
    }

    /// The stable discussions endpoint — `glab mr note list`, which this
    /// replaced, is documented by glab itself as experimental.
    async fn get_mr_threads(
        &self,
        repo: &Repo,
        remote_id: &str,
    ) -> anyhow::Result<serde_json::Value> {
        let v = api::gitlab(
            &repo.host,
            Method::GET,
            &format!("{}/discussions?per_page=100", mr_path(repo, remote_id)),
            None,
        )
        .await?;
        Ok(threads_from_discussions(&v))
    }

    async fn get_mr_ci(&self, repo: &Repo, remote_id: &str) -> anyhow::Result<serde_json::Value> {
        let v = mr_json(repo, remote_id).await?;
        let p = if v["head_pipeline"].is_object() { &v["head_pipeline"] } else { &v["pipeline"] };
        if !p.is_object() {
            return Ok(serde_json::Value::Null);
        }
        Ok(serde_json::json!({
            "status": p["status"].as_str().unwrap_or("unknown"),
            "url": p["web_url"].as_str().unwrap_or(""),
        }))
    }

    async fn get_mr_details(&self, repo: &Repo, remote_id: &str) -> anyhow::Result<serde_json::Value> {
        let v = mr_json(repo, remote_id).await?;
        Ok(serde_json::json!({
            "title": v["title"].as_str().unwrap_or(""),
            "description": v["description"].as_str().unwrap_or(""),
            "author": v["author"]["username"].as_str().or(v["author"]["name"].as_str()).unwrap_or(""),
            "source_branch": v["source_branch"].as_str().unwrap_or(""),
            "target_branch": v["target_branch"].as_str().unwrap_or(""),
            "state": glab_state(v["state"].as_str().unwrap_or("opened")),
            "draft": v["draft"].as_bool().or(v["work_in_progress"].as_bool()).unwrap_or(false),
            "created_at": v["created_at"].as_str().unwrap_or(""),
            "web_url": v["web_url"].as_str().unwrap_or(""),
        }))
    }

    async fn reply_to_thread(
        &self,
        repo: &Repo,
        remote_id: &str,
        thread_id: &str,
        body: &str,
    ) -> anyhow::Result<()> {
        // Into the thread itself — the CLI path could only leave a general note.
        let path = if thread_id.is_empty() {
            format!("{}/notes", mr_path(repo, remote_id))
        } else {
            format!("{}/discussions/{thread_id}/notes", mr_path(repo, remote_id))
        };
        api::gitlab(&repo.host, Method::POST, &path, Some(&serde_json::json!({ "body": body })))
            .await?;
        Ok(())
    }

    async fn resolve_mr_thread(
        &self,
        repo: &Repo,
        remote_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<()> {
        api::gitlab(
            &repo.host,
            Method::PUT,
            &format!("{}/discussions/{thread_id}", mr_path(repo, remote_id)),
            Some(&serde_json::json!({ "resolved": true })),
        )
        .await?;
        Ok(())
    }

    async fn approve_mr(&self, repo: &Repo, remote_id: &str) -> anyhow::Result<()> {
        api::gitlab(
            &repo.host,
            Method::POST,
            &format!("{}/approve", mr_path(repo, remote_id)),
            None,
        )
        .await?;
        Ok(())
    }

    async fn get_mr_approval(&self, repo: &Repo, remote_id: &str) -> anyhow::Result<serde_json::Value> {
        let v = api::gitlab(
            &repo.host,
            Method::GET,
            &format!("{}/approvals", mr_path(repo, remote_id)),
            None,
        )
        .await?;
        let by: Vec<String> = v["approved_by"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| a["user"]["username"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        Ok(serde_json::json!({
            "approved": v["approved"].as_bool().unwrap_or(!by.is_empty()),
            // GitLab reports this per-token, so it answers "did I approve?".
            "approved_by_me": v["user_has_approved"].as_bool().unwrap_or(false),
            "approved_by": by,
        }))
    }

    async fn post_mr_comment(
        &self,
        repo: &Repo,
        remote_id: &str,
        body: &str,
        position: Option<(&str, i64)>,
    ) -> anyhow::Result<()> {
        let Some((new_path, new_line)) = position else {
            api::gitlab(
                &repo.host,
                Method::POST,
                &format!("{}/notes", mr_path(repo, remote_id)),
                Some(&serde_json::json!({ "body": body })),
            )
            .await?;
            return Ok(());
        };

        // Positioned discussion: GitLab needs the MR's diff_refs shas. Caveat:
        // positions reference the REMOTE MR head — local commits in the review
        // worktree can drift line numbers, so post before editing.
        let v = mr_json(repo, remote_id).await?;
        let refs = &v["diff_refs"];
        if !refs.is_object() || refs["head_sha"].is_null() {
            return Err(anyhow::anyhow!(
                "MR !{remote_id} has no diff_refs — cannot position the comment"
            ));
        }

        // Read the MR's diff to learn what kind of line this is before posting.
        // Guessing can't work: GitLab needs old+new for an unchanged line, only
        // one of them for an added or deleted line, and refuses the request with
        // `line_code: must be a valid line code` when the pair doesn't match.
        let anchor = locate_line(repo, remote_id, new_path, new_line).await?;
        let mut pos = serde_json::json!({
            "position_type": "text",
            "base_sha": refs["base_sha"],
            "start_sha": refs["start_sha"],
            "head_sha": refs["head_sha"],
            "old_path": anchor.old_path,
            "new_path": anchor.new_path,
        });
        if let Some(old) = anchor.old_line {
            pos["old_line"] = serde_json::json!(old);
        }
        if let Some(new) = anchor.new_line {
            pos["new_line"] = serde_json::json!(new);
        }
        let discussions_path = format!("{}/discussions", mr_path(repo, remote_id));
        let created = api::gitlab(
            &repo.host,
            Method::POST,
            &discussions_path,
            Some(&serde_json::json!({ "body": body, "position": pos })),
        )
        .await?;

        // Verify the anchor actually landed. A note without a `position` IS the
        // context-less comment this method exists to avoid, so roll it back and
        // report rather than leaving it on the MR.
        if created["notes"][0]["position"].is_object() {
            return Ok(());
        }
        let discussion_id = created["id"].as_str().unwrap_or("").to_string();
        let note_id = created["notes"][0]["id"].as_i64();
        if let (false, Some(note_id)) = (discussion_id.is_empty(), note_id) {
            let _ = api::gitlab(
                &repo.host,
                Method::DELETE,
                &format!("{discussions_path}/{discussion_id}/notes/{note_id}"),
                None,
            )
            .await;
        }
        Err(anyhow::anyhow!(
            "GitLab did not anchor the comment to {new_path}:{new_line} — that line may not be \
             part of this MR's diff, or the MR head moved. Nothing was posted."
        ))
    }
}

/// Where one line of a file sits in an MR's diff.
///
/// GitLab derives a comment's `line_code` from the PAIR of line numbers, so which
/// fields a position must carry depends on what kind of line it is:
///   added     → `new_line` only (there is no old line)
///   deleted   → `old_line` only (there is no new line)
///   unchanged → BOTH, because a context line exists on both sides
/// Sending one number for an unchanged line is what produced
/// `Note {:line_code=>["can't be blank", "must be a valid line code"]}` — and most
/// review comments land on context lines, so this is the common case, not an edge.
struct DiffAnchor {
    old_line: Option<i64>,
    new_line: Option<i64>,
    old_path: String,
    new_path: String,
}

/// Locate `line` in the MR's diff for `path`.
///
/// `line` is a new-side number by our own convention, but an annotation on a
/// DELETED line can only carry an old-side one, so the new side is tried first and
/// the old side second. Returns the paths from the diff too, which is what makes
/// comments work on files renamed inside the MR.
async fn locate_line(
    repo: &Repo,
    remote_id: &str,
    path: &str,
    line: i64,
) -> anyhow::Result<DiffAnchor> {
    let v = api::gitlab(
        &repo.host,
        Method::GET,
        &format!("{}/diffs?per_page=100", mr_path(repo, remote_id)),
        None,
    )
    .await?;
    let files = v
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("could not read MR !{remote_id}'s diff"))?;

    let file = files
        .iter()
        .find(|f| f["new_path"].as_str() == Some(path) || f["old_path"].as_str() == Some(path))
        .ok_or_else(|| {
            anyhow::anyhow!("{path} is not part of MR !{remote_id} — nothing was posted.")
        })?;

    let old_path = file["old_path"].as_str().unwrap_or(path).to_string();
    let new_path = file["new_path"].as_str().unwrap_or(path).to_string();
    let diff = file["diff"].as_str().unwrap_or_default();

    match resolve_in_diff(diff, line) {
        Ok((old_line, new_line)) => Ok(DiffAnchor { old_line, new_line, old_path, new_path }),
        Err(commentable) => Err(anyhow::anyhow!(
            "line {line} of {path} is not in MR !{remote_id}'s diff, so GitLab has nothing to \
             anchor to — comment on one of its changed regions instead ({}). Nothing was posted.",
            describe_ranges(&commentable)
        )),
    }
}

/// Find `line` in a unified diff and return the `(old_line, new_line)` pair
/// GitLab needs. On failure, hands back every new-side line that IS commentable.
///
/// `line` is treated as a new-side number first (our convention) and as an
/// old-side one second, which is the only way to anchor a comment on a line the
/// MR deleted.
#[allow(clippy::type_complexity)]
fn resolve_in_diff(diff: &str, line: i64) -> Result<(Option<i64>, Option<i64>), Vec<i64>> {
    let mut old_no = 0i64;
    let mut new_no = 0i64;
    let mut by_new: Vec<(i64, Option<i64>)> = vec![]; // (new_line, old_line if unchanged)
    let mut by_old: Vec<i64> = vec![]; // deleted lines

    for raw_line in diff.lines() {
        if let Some((old, new)) = parse_hunk_header(raw_line) {
            old_no = old;
            new_no = new;
            continue;
        }
        match raw_line.chars().next() {
            Some('+') => {
                by_new.push((new_no, None));
                new_no += 1;
            }
            Some('-') => {
                by_old.push(old_no);
                old_no += 1;
            }
            // `\ No newline at end of file` is metadata, not a line.
            Some('\\') => {}
            // A context line — present on both sides, so it carries both numbers.
            Some(_) | None => {
                by_new.push((new_no, Some(old_no)));
                old_no += 1;
                new_no += 1;
            }
        }
    }

    if let Some((_, old)) = by_new.iter().find(|(n, _)| *n == line) {
        return Ok((*old, Some(line)));
    }
    if by_old.contains(&line) {
        return Ok((Some(line), None));
    }
    Err(by_new.iter().map(|(n, _)| *n).collect())
}

/// `@@ -old,count +new,count @@` → the two starting line numbers.
fn parse_hunk_header(line: &str) -> Option<(i64, i64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let new = rest.split_once(" @@").map(|(n, _)| n).unwrap_or(rest);
    let first = |s: &str| s.split(',').next().unwrap_or(s).parse::<i64>().ok();
    Some((first(old)?, first(new)?))
}

/// Collapse line numbers into "12-40, 88-96" for an actionable error message.
fn describe_ranges(lines: &[i64]) -> String {
    let mut out: Vec<String> = vec![];
    let mut start: Option<i64> = None;
    let mut prev = 0i64;
    for &n in lines {
        match start {
            None => start = Some(n),
            Some(s) if n != prev + 1 => {
                out.push(if s == prev { s.to_string() } else { format!("{s}-{prev}") });
                start = Some(n);
            }
            _ => {}
        }
        prev = n;
    }
    if let Some(s) = start {
        out.push(if s == prev { s.to_string() } else { format!("{s}-{prev}") });
    }
    if out.is_empty() { "none".to_string() } else { out.join(", ") }
}

/// Every MR on the worktree's branch, whatever its state, upserted into the DB.
/// No state filter: a merged or closed MR has to rewrite its stored row.
pub(super) async fn fetch_and_upsert_mrs(
    wt: &Worktree,
    repo: &Repo,
    pool: &SqlitePool,
) -> anyhow::Result<Vec<Mr>> {
    let v = api::gitlab(
        &repo.host,
        Method::GET,
        &format!(
            "projects/{}/merge_requests?source_branch={}&state=all",
            project_ref(repo),
            pct(&wt.branch)
        ),
        None,
    )
    .await?;

    let mut result = vec![];
    for item in v.as_array().cloned().unwrap_or_default() {
        let iid = item["iid"].as_u64().unwrap_or(0).to_string();
        let url = item["web_url"].as_str().unwrap_or("").to_string();
        let state = glab_state(item["state"].as_str().unwrap_or("opened"));
        result.push(store::mrs::upsert(pool, &wt.id, "gitlab", &iid, &url, &state).await?);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real hunk from wiremind/devops/cluster-manager!1828 that exposed this:
    /// commenting on new line 114 (a CONTEXT line, old 87) was rejected with
    /// `line_code: must be a valid line code` because only one number was sent.
    const HUNK: &str = concat!(
        "@@ -82,11 +106,14 @@ class GitlabSetCRPolicies(GitlabHelper):\n",
        "             logger.debug(f\"disabled\")\n",
        "             return\n",
        " \n",
        "+        # A project may define its own 'older_than'\n",
        "+        older_than = self.project_older_than.get(project.path_with_namespace)\n",
        "+\n",
        "         policy_attributes = {\n",
        "             \"cadence\": self.cadence,\n",
        "             \"enabled\": not self.disabled,\n",
    );

    #[test]
    fn context_line_carries_both_numbers() {
        // new 114 == old 87 in this hunk: header starts at old 82 / new 106, and
        // three added lines shift the two sides apart by 27.
        assert_eq!(resolve_in_diff(HUNK, 114), Ok((Some(87), Some(114))));
    }

    #[test]
    fn added_line_has_no_old_number() {
        // new 109-111 are the '+' lines.
        assert_eq!(resolve_in_diff(HUNK, 109), Ok((None, Some(109))));
    }

    #[test]
    fn deleted_line_is_found_on_the_old_side() {
        // Only new line 50 survives here, so 52 can only be the old-side deletion.
        let diff = "@@ -50,4 +50,1 @@\n ctx\n-gone1\n-gone2\n-gone3\n";
        assert_eq!(resolve_in_diff(diff, 52), Ok((Some(52), None)));
    }

    /// A number that is valid on BOTH sides must resolve as the new side — that is
    /// our convention for what an annotation's line means, and guessing otherwise
    /// would move comments to unrelated code.
    #[test]
    fn the_new_side_wins_when_a_number_exists_on_both() {
        let diff = "@@ -10,3 +10,2 @@\n ctx\n-gone\n ctx2\n";
        // new 11 is the context line `ctx2` (old 12); old 11 is the deleted `gone`.
        assert_eq!(resolve_in_diff(diff, 11), Ok((Some(12), Some(11))));
    }

    #[test]
    fn a_line_outside_the_diff_reports_what_is_commentable() {
        let commentable = resolve_in_diff(HUNK, 400).expect_err("400 is not in the hunk");
        assert_eq!(describe_ranges(&commentable), "106-114");
    }

    #[test]
    fn hunk_headers_parse_with_and_without_counts() {
        assert_eq!(parse_hunk_header("@@ -82,11 +106,14 @@ class X:"), Some((82, 106)));
        assert_eq!(parse_hunk_header("@@ -1 +1 @@"), Some((1, 1)));
        assert_eq!(parse_hunk_header(" not a header"), None);
    }

    #[test]
    fn ranges_collapse_into_readable_spans() {
        assert_eq!(describe_ranges(&[1, 2, 3, 9, 10, 40]), "1-3, 9-10, 40");
        assert_eq!(describe_ranges(&[]), "none");
    }

    /// Captured shape of `GET …/discussions`: a review thread, a system
    /// discussion ("added 1 commit"), and a general note.
    #[test]
    fn discussions_reshape_and_system_noise_is_dropped() {
        let raw = serde_json::json!([
            { "id": "abc123", "notes": [
                { "id": 1, "body": "issue: x", "system": false, "resolvable": true,
                  "resolved": false, "author": { "username": "arthur" },
                  "position": { "new_path": "a.rs", "new_line": 4 } }
            ]},
            { "id": "sys1", "notes": [
                { "id": 2, "body": "added 1 commit", "system": true }
            ]},
            { "id": "gen1", "notes": [
                { "id": 3, "body": "nice", "system": false, "resolvable": false, "resolved": false,
                  "author": { "username": "b" } }
            ]}
        ]);
        let out = threads_from_discussions(&raw);
        let threads = out.as_array().unwrap();
        assert_eq!(threads.len(), 2, "the system discussion is gone");
        assert_eq!(threads[0]["id"], "abc123");
        assert_eq!(threads[0]["notes"][0]["author"]["username"], "arthur");
        assert_eq!(threads[0]["notes"][0]["position"]["new_line"], 4);
        assert_eq!(threads[1]["notes"][0]["body"], "nice");
    }
}
