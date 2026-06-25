import {
  Avatar,
  Box,
  Chip,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography
} from "@mui/material";
import {
  DashboardRounded,
  MenuBookRounded,
  SecurityRounded
} from "@mui/icons-material";

export function MobileDrawer(props: {
  open: boolean;
  onClose: () => void;
  page: "command" | "contracts";
  setPage: (p: "command" | "contracts") => void;
  contractCount: number;
}) {
  function navigate(p: "command" | "contracts") {
    props.setPage(p);
    props.onClose();
  }

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      PaperProps={{
        sx: {
          width: 260,
          bgcolor: "rgba(8, 12, 11, .97)",
          borderRight: "1px solid",
          borderColor: "divider"
        }
      }}
    >
      <Box sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1.3} sx={{ px: 1, py: 1, mb: 2 }}>
          <Avatar
            variant="rounded"
            sx={{
              width: 36,
              height: 36,
              bgcolor: "rgba(114, 227, 163, .11)",
              color: "primary.light",
              border: "1px solid rgba(114, 227, 163, .25)"
            }}
          >
            <SecurityRounded sx={{ fontSize: 19 }} />
          </Avatar>
          <Box>
            <Typography fontWeight={720} letterSpacing="-.02em">
              Maximal
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Safe execution
            </Typography>
          </Box>
        </Stack>

        <List>
          <ListItemButton
            selected={props.page === "command"}
            onClick={() => navigate("command")}
            sx={{ borderRadius: 2, mb: 0.7 }}
            aria-current={props.page === "command" ? "page" : undefined}
          >
            <ListItemIcon sx={{ minWidth: 36 }}>
              <DashboardRounded fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary="Command center"
              primaryTypographyProps={{ fontSize: 13, fontWeight: 600 }}
            />
          </ListItemButton>
          <ListItemButton
            selected={props.page === "contracts"}
            onClick={() => navigate("contracts")}
            sx={{ borderRadius: 2 }}
            aria-current={props.page === "contracts" ? "page" : undefined}
          >
            <ListItemIcon sx={{ minWidth: 36 }}>
              <MenuBookRounded fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary="Contracts"
              primaryTypographyProps={{ fontSize: 13, fontWeight: 600 }}
            />
            <Chip size="small" label={props.contractCount} sx={{ height: 21, fontSize: 9.5 }} />
          </ListItemButton>
        </List>
      </Box>
    </Drawer>
  );
}
