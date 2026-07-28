import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronRight, FolderClosed, FolderOpen, Lock } from "lucide-react";
import useExpandedNodes from "./useExpandedNodes";

// Reusable recursive nav-tree renderer: a node is either a leaf (`path` set
// -> real link, `path: null` -> disabled "Coming Soon" row) or a category
// (`children` set -> folder icon + toggle, recurses into its own children).
// Depth is unbounded - Aging Reports / Prepaid Accounts Reports nest a
// second level today, but a third level works with zero code changes.
// Wired up for the Reports menu only (see sidebar.jsx); File Setup and
// Transactions keep their existing hand-rolled markup.

function findAncestorIds(nodes, targetPath, trail = []) {
  for (const node of nodes) {
    if (node.path && node.path === targetPath) return trail;
    if (node.children) {
      const found = findAncestorIds(node.children, targetPath, [...trail, node.id]);
      if (found) return found;
    }
  }
  return null;
}

function containsActivePath(node, pathname) {
  if (node.path && node.path === pathname) return true;
  if (!node.children) return false;
  return node.children.some((child) => containsActivePath(child, pathname));
}

function NavNode({ node, depth, expanded, toggle, activePath }) {
  const style = { "--rt-depth": depth };

  if (node.children) {
    const isOpen = expanded.has(node.id);
    const isAncestorOfActive = containsActivePath(node, activePath);
    const FolderIcon = isOpen ? FolderOpen : FolderClosed;

    return (
      <div className="rt-branch">
        <button
          type="button"
          className={`rt-node rt-category${isAncestorOfActive ? " rt-category-active" : ""}`}
          style={style}
          onClick={() => toggle(node.id)}
          aria-expanded={isOpen}
        >
          <FolderIcon size={15} className="rt-icon" aria-hidden="true" />
          <span className="rt-label">{node.label}</span>
          <ChevronRight size={14} className={`rt-chevron${isOpen ? " rt-chevron-open" : ""}`} aria-hidden="true" />
        </button>

        <div className={`rt-children${isOpen ? " rt-children-open" : ""}`}>
          <div className="rt-children-inner">
            {node.children.map((child) => (
              <NavNode
                key={child.id}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                activePath={activePath}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const Icon = node.icon;

  if (!node.path) {
    return (
      <button
        type="button"
        className="rt-node rt-leaf rt-disabled"
        style={style}
        disabled
        title="Coming soon"
      >
        <Icon size={15} className="rt-icon" aria-hidden="true" />
        <span className="rt-label">{node.label}</span>
        <Lock size={12} className="rt-lock" aria-hidden="true" />
      </button>
    );
  }

  const isActive = node.path === activePath;

  return (
    <Link to={node.path} className={`rt-node rt-leaf${isActive ? " rt-active" : ""}`} style={style}>
      <Icon size={15} className="rt-icon" aria-hidden="true" />
      <span className="rt-label">{node.label}</span>
    </Link>
  );
}

export default function NavTree({ nodes, namespace }) {
  const location = useLocation();
  const { expanded, toggle, expandIds } = useExpandedNodes(namespace);

  useEffect(() => {
    const ancestors = findAncestorIds(nodes, location.pathname);
    if (ancestors && ancestors.length) {
      expandIds(ancestors);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return (
    <div className="rt-tree">
      {nodes.map((node) => (
        <NavNode
          key={node.id}
          node={node}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          activePath={location.pathname}
        />
      ))}
    </div>
  );
}
