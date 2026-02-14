//! State tree implementation.
//!
//! State is a tree of values addressable by path. From PROTOCOL.md:
//! ```text
//! State : Path -> Value | Undefined
//! Path  : List<String>
//! Value : Bytes
//! ```

use crate::Hash;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A path is a list of string segments.
pub type Path = Vec<String>;

/// A value is raw bytes.
pub type Value = Vec<u8>;

/// A node in the state tree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Node {
    /// A leaf value.
    Value(Value),
    /// A subtree.
    Tree(BTreeMap<String, Node>),
}

impl Default for Node {
    fn default() -> Self {
        Node::Tree(BTreeMap::new())
    }
}

/// The state tree.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    root: BTreeMap<String, Node>,
}

impl State {
    /// Create an empty state.
    pub fn new() -> Self {
        Self::default()
    }

    /// Get a value at a path.
    pub fn get(&self, path: &[&str]) -> Option<&Value> {
        if path.is_empty() {
            return None;
        }

        let mut current: &BTreeMap<String, Node> = &self.root;

        for (i, segment) in path.iter().enumerate() {
            match current.get(*segment) {
                Some(Node::Value(v)) if i == path.len() - 1 => return Some(v),
                Some(Node::Tree(subtree)) => current = subtree,
                _ => return None,
            }
        }

        None
    }

    /// Get a value at a path (owned path version).
    pub fn get_path(&self, path: &Path) -> Option<&Value> {
        let refs: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
        self.get(&refs)
    }

    /// Set a value at a path. Creates intermediate trees as needed.
    pub fn set(&mut self, path: &[&str], value: Value) {
        if path.is_empty() {
            return;
        }

        let mut current = &mut self.root;

        for (i, segment) in path.iter().enumerate() {
            if i == path.len() - 1 {
                // Last segment: insert the value
                current.insert(segment.to_string(), Node::Value(value));
                return;
            }

            // Intermediate segment: ensure it's a tree
            // First, ensure the entry exists and is a tree
            let needs_tree = match current.get(segment.to_owned()) {
                Some(Node::Value(_)) => true,
                None => true,
                Some(Node::Tree(_)) => false,
            };

            if needs_tree {
                current.insert(segment.to_string(), Node::Tree(BTreeMap::new()));
            }

            current = match current.get_mut(*segment) {
                Some(Node::Tree(subtree)) => subtree,
                _ => unreachable!("we just inserted a tree"),
            };
        }
    }

    /// Set a value at a path (owned path version).
    pub fn set_path(&mut self, path: &Path, value: Value) {
        let refs: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
        self.set(&refs, value);
    }

    /// Delete a value at a path. Returns true if something was deleted.
    pub fn delete(&mut self, path: &[&str]) -> bool {
        if path.is_empty() {
            return false;
        }

        self.delete_recursive(&mut self.root.clone(), path, 0)
            .map(|new_root| {
                self.root = new_root;
                true
            })
            .unwrap_or(false)
    }

    fn delete_recursive(
        &self,
        current: &mut BTreeMap<String, Node>,
        path: &[&str],
        depth: usize,
    ) -> Option<BTreeMap<String, Node>> {
        let segment = path[depth];

        if depth == path.len() - 1 {
            // Last segment: remove it
            if current.remove(segment).is_some() {
                return Some(current.clone());
            }
            return None;
        }

        // Intermediate segment: recurse
        match current.get_mut(segment) {
            Some(Node::Tree(subtree)) => {
                if let Some(new_subtree) = self.delete_recursive(subtree, path, depth + 1) {
                    if new_subtree.is_empty() {
                        current.remove(segment);
                    } else {
                        current.insert(segment.to_string(), Node::Tree(new_subtree));
                    }
                    return Some(current.clone());
                }
            }
            _ => {}
        }

        None
    }

    /// Delete a value at a path (owned path version).
    pub fn delete_path(&mut self, path: &Path) -> bool {
        let refs: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
        self.delete(&refs)
    }

    /// Enumerate all paths with values under a prefix.
    pub fn enumerate(&self, prefix: &[&str]) -> Vec<Path> {
        let mut results = Vec::new();

        // Navigate to the prefix
        let subtree = if prefix.is_empty() {
            &self.root
        } else {
            let mut current = &self.root;
            for segment in prefix {
                match current.get(*segment) {
                    Some(Node::Tree(subtree)) => current = subtree,
                    Some(Node::Value(_)) => {
                        // Prefix points to a value
                        results.push(prefix.iter().map(|s| s.to_string()).collect());
                        return results;
                    }
                    None => return results,
                }
            }
            current
        };

        // Walk the subtree
        let prefix_path: Path = prefix.iter().map(|s| s.to_string()).collect();
        self.enumerate_recursive(subtree, prefix_path, &mut results);

        results
    }

    fn enumerate_recursive(
        &self,
        node: &BTreeMap<String, Node>,
        current_path: Path,
        results: &mut Vec<Path>,
    ) {
        for (key, value) in node {
            let mut path = current_path.clone();
            path.push(key.clone());

            match value {
                Node::Value(_) => results.push(path),
                Node::Tree(subtree) => self.enumerate_recursive(subtree, path, results),
            }
        }
    }

    /// Enumerate all paths (prefix = root).
    pub fn enumerate_all(&self) -> Vec<Path> {
        self.enumerate(&[])
    }

    /// Compute the content hash of the entire state.
    pub fn hash(&self) -> Hash {
        Hash::of_value(&self.root)
    }

    /// Check if the state is empty.
    pub fn is_empty(&self) -> bool {
        self.root.is_empty()
    }

    /// Get the number of values in the state.
    pub fn len(&self) -> usize {
        self.enumerate_all().len()
    }

    /// Iterate over all path-value pairs.
    pub fn iter(&self) -> impl Iterator<Item = (Path, &Value)> {
        self.enumerate_all().into_iter().filter_map(move |path| {
            self.get_path(&path).map(|v| (path, v))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_state() {
        let state = State::new();
        assert!(state.is_empty());
        assert_eq!(state.get(&["anything"]), None);
    }

    #[test]
    fn set_and_get() {
        let mut state = State::new();
        state.set(&["entities", "alice", "name"], b"Alice".to_vec());

        assert_eq!(
            state.get(&["entities", "alice", "name"]),
            Some(&b"Alice".to_vec())
        );
        assert_eq!(state.get(&["entities", "alice"]), None); // Not a value
        assert_eq!(state.get(&["entities"]), None);
        assert_eq!(state.get(&["nonexistent"]), None);
    }

    #[test]
    fn overwrite_value() {
        let mut state = State::new();
        state.set(&["key"], b"v1".to_vec());
        state.set(&["key"], b"v2".to_vec());

        assert_eq!(state.get(&["key"]), Some(&b"v2".to_vec()));
    }

    #[test]
    fn delete_value() {
        let mut state = State::new();
        state.set(&["a", "b", "c"], b"value".to_vec());

        assert!(state.delete(&["a", "b", "c"]));
        assert_eq!(state.get(&["a", "b", "c"]), None);

        // Parent trees should be cleaned up if empty
        assert!(state.is_empty() || state.enumerate_all().is_empty());
    }

    #[test]
    fn enumerate_paths() {
        let mut state = State::new();
        state.set(&["entities", "alice", "name"], b"Alice".to_vec());
        state.set(&["entities", "alice", "age"], b"30".to_vec());
        state.set(&["entities", "bob", "name"], b"Bob".to_vec());
        state.set(&["config", "version"], b"1".to_vec());

        let all_paths = state.enumerate_all();
        assert_eq!(all_paths.len(), 4);

        let entity_paths = state.enumerate(&["entities"]);
        assert_eq!(entity_paths.len(), 3);

        let alice_paths = state.enumerate(&["entities", "alice"]);
        assert_eq!(alice_paths.len(), 2);
    }

    #[test]
    fn hash_determinism() {
        let mut s1 = State::new();
        s1.set(&["a"], b"1".to_vec());
        s1.set(&["b"], b"2".to_vec());

        let mut s2 = State::new();
        s2.set(&["b"], b"2".to_vec());
        s2.set(&["a"], b"1".to_vec());

        // Order of insertion shouldn't matter (BTreeMap is ordered)
        assert_eq!(s1.hash(), s2.hash());
    }

    #[test]
    fn hash_sensitivity() {
        let mut s1 = State::new();
        s1.set(&["key"], b"value1".to_vec());

        let mut s2 = State::new();
        s2.set(&["key"], b"value2".to_vec());

        assert_ne!(s1.hash(), s2.hash());
    }
}
