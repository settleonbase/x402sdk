# Shared path checks for certificate delivery and install.
# A bad stamp or directory is refused before any copy or current switch.
signer_edge_refuse_unsafe() {
	_label=$1
	_path=$2
	if [ -z "$_path" ]; then
		echo "${_label}-refused reason=name" >&2
		return 1
	fi
	case "$_path" in
		*[[:space:]]*|*"'"*|*"\""*|*'\'*|*'$'*|*'`'|*';'*|*'&'*|*'|'*|*'<'*|*'>'*)
			echo "${_label}-refused reason=name" >&2
			return 1
			;;
	esac
	_rest=$_path
	while [ -n "$_rest" ]; do
		_comp=${_rest%%/*}
		if [ "$_comp" = ".." ]; then
			echo "${_label}-refused reason=traversal" >&2
			return 1
		fi
		case "$_rest" in
			*/*) _rest=${_rest#*/} ;;
			*) _rest= ;;
		esac
	done
	_walk=$_path
	case "$_walk" in
		/*) ;;
		*) _walk=$(pwd)/$_walk ;;
	esac
	while [ "$_walk" != / ]; do
		if [ -L "$_walk" ]; then
			echo "${_label}-refused reason=symlink" >&2
			return 1
		fi
		_walk=$(dirname "$_walk")
	done
	return 0
}

signer_edge_stamp_ok() {
	case "$1" in
		''|.|..|.*|*/*) return 1 ;;
	esac
	case "$1" in
		*[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}
